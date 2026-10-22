import type { StreamEvent } from '../framework/hooks/output-sink.js';

/**
 * Narrated talk mode: what Bernard writes BETWEEN tool calls is spoken as it
 * happens, so a listener hears "let me see what this says" rather than
 * minutes of silence before the answer.
 *
 * Fed the same stream the transcript renders from. Text is collected per step
 * and handed over at the step's first tool call — that is the moment the
 * sentence is complete and the work it announces starts. The step that ends
 * the turn has no tool call, so its text is never handed over here: it is the
 * reply, which the readback speaks once the turn is done, and handing it over
 * as well would say it twice.
 *
 * Main agent only. A sub-agent's or wrapper's text carries an `agentLabel`
 * and is its working, not something said to the person. Reasoning never
 * reaches this stream as text, so thoughts are not read out either.
 */
export class Narrator {
  private buffer = '';

  constructor(private readonly say: (text: string) => void) {}

  onEvent(event: StreamEvent): void {
    if (event.agentLabel !== undefined) return;
    if (event.kind === 'text-delta') {
      this.buffer += event.text;
      return;
    }
    if (event.kind === 'tool-call') this.flush();
  }

  /** Drops anything collected: a new turn, or one that was stopped. */
  reset(): void {
    this.buffer = '';
  }

  private flush(): void {
    const text = this.buffer.trim();
    this.buffer = '';
    if (text) this.say(text);
  }
}

/**
 * What the model is told in narrated talk mode, as a per-turn context section
 * so the cached system prompt does not change when talk mode starts or stops.
 * Short on purpose: a listener waits for every word of it.
 */
export const VOICE_NARRATION_GUIDANCE = [
  'The user is listening to you, not reading. Before each step that uses tools,',
  'say in one short spoken sentence what you are about to do, first person and',
  'plain words, for example "Let me draft that up for you." or "Let me see what',
  'this says." About ten words at most, no markdown, no tool or file names.',
  'Do not narrate your reasoning.',
].join(' ');
