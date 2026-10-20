import { Endpointer, type EndpointerOptions } from './endpointer.js';
import type { MicHandle } from './recorder.js';

/**
 * The hands-free loop: listen → transcribe → think → speak → listen. React-free
 * and vendor-free — every effect is injected — so the state machine is tested
 * with fakes and the REPL only supplies the four doors.
 *
 * **Half-duplex.** The microphone is closed while Bernard is talking, which is
 * what stops it transcribing its own voice. Interrupting by speaking over it
 * (barge-in) needs echo cancellation and is a separate change.
 */

export type TalkState = 'listening' | 'transcribing' | 'thinking' | 'speaking';

export interface TalkDeps {
  rate: number;
  startMic(onChunk: (pcm: Int16Array) => void, onError: (err: Error) => void): MicHandle;
  transcribe(samples: Int16Array, signal: AbortSignal): Promise<string>;
  /** Runs one turn; resolves to the reply to speak, or null for nothing. */
  submit(text: string): Promise<string | null>;
  /** Speaks; resolves when playback ends or is cancelled. */
  speak(text: string): Promise<unknown>;
  onState(state: TalkState): void;
  /** A recoverable problem the loop is carrying on past. */
  onError(message: string): void;
  /** The session ended by itself, with the reason to show. */
  onEnded(reason: string): void;
  endpointer?: Partial<EndpointerOptions>;
}

/** Consecutive transcription failures before the session gives up. */
export const MAX_CONSECUTIVE_FAILURES = 2;

export class TalkSession {
  private mic: MicHandle | null = null;
  private stopped = false;
  private failures = 0;
  private readonly abort = new AbortController();

  constructor(private readonly deps: TalkDeps) {}

  get active(): boolean {
    return !this.stopped;
  }

  start(): void {
    this.listen();
  }

  /** Ends the session from outside. Idempotent; never reports `onEnded`. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.closeMic();
    this.abort.abort();
  }

  private end(reason: string): void {
    if (this.stopped) return;
    this.stop();
    this.deps.onEnded(reason);
  }

  private closeMic(): void {
    this.mic?.stop();
    this.mic = null;
  }

  private listen(): void {
    if (this.stopped) return;
    this.deps.onState('listening');
    const endpointer = new Endpointer({ rate: this.deps.rate, ...this.deps.endpointer });
    let done = false;
    this.mic = this.deps.startMic(
      (pcm) => {
        if (done || this.stopped) return;
        for (const e of endpointer.push(pcm)) {
          if (e.type === 'utterance') {
            done = true;
            this.closeMic();
            void this.handle(e.samples);
            return;
          }
          if (e.type === 'no-speech') {
            done = true;
            this.end('Stopped listening after a long silence.');
            return;
          }
        }
      },
      (err) => {
        if (done) return;
        done = true;
        this.end(`The microphone stopped: ${err.message}`);
      },
    );
  }

  private async handle(samples: Int16Array): Promise<void> {
    if (this.stopped) return;
    this.deps.onState('transcribing');
    let text: string;
    try {
      text = await this.deps.transcribe(samples, this.abort.signal);
      this.failures = 0;
    } catch (err) {
      if (this.stopped) return;
      this.failures++;
      const message = err instanceof Error ? err.message : String(err);
      if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
        this.end(`Transcription keeps failing: ${message}`);
        return;
      }
      this.deps.onError(`Could not transcribe that: ${message}`);
      this.listen();
      return;
    }
    if (this.stopped) return;
    // Nothing intelligible: listen again rather than start an empty turn.
    if (!text.trim()) {
      this.listen();
      return;
    }

    this.deps.onState('thinking');
    const reply = await this.deps.submit(text).catch(() => null);
    if (this.stopped) return;
    if (reply?.trim()) {
      this.deps.onState('speaking');
      await this.deps.speak(reply).catch(() => undefined);
    }
    this.listen();
  }
}
