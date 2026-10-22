import { Endpointer, type EndpointerOptions } from './endpointer.js';
import type { MicHandle } from './recorder.js';
import { spokenText } from './conversation.js';
import { speechLog } from './log.js';

/**
 * Dictation (`/dictate`): speech goes into the composer, and nothing runs
 * until the person presses Enter. Talk mode submits the moment an utterance
 * ends, and an utterance ends at the first long-enough pause — which is often
 * mid-thought, so a sentence arrived as a turn half-said. Here a pause only
 * ends one piece of text; the person decides when the whole of it is a
 * request, and can fix a mis-heard word before sending.
 *
 * React-free and vendor-free, like `TalkSession`: every effect is injected.
 *
 * **The mic stays open while a piece is transcribed**, unlike talk mode, which
 * closes it to think. Nothing here speaks, so there is no echo to hear, and
 * closing it would drop the start of whatever the person says next.
 * Transcriptions run in order, so pieces land in the composer in the order
 * they were said even when a short one comes back first.
 *
 * **`pause()` closes it while Bernard speaks a reply**, the half-duplex rule
 * talk mode has, and for the same reason: the readback would otherwise be
 * transcribed into the composer.
 */

export type DictationState = 'listening' | 'transcribing' | 'paused';

export interface DictationDeps {
  rate: number;
  startMic(onChunk: (pcm: Int16Array) => void, onError: (err: Error) => void): MicHandle;
  transcribe(samples: Int16Array, signal: AbortSignal): Promise<string>;
  /** One piece of what was said, already cleaned. Goes into the composer. */
  onText(text: string): void;
  onState(state: DictationState): void;
  /** A recoverable problem the session is carrying on past. */
  onError(message: string): void;
  /** The session ended by itself, with the reason to show. */
  onEnded(reason: string): void;
  endpointer?: Partial<EndpointerOptions>;
}

/** Consecutive transcription failures before the session gives up. */
export const MAX_DICTATION_FAILURES = 2;

export class DictationSession {
  private mic: MicHandle | null = null;
  private stopped = false;
  private paused = false;
  private failures = 0;
  /** Transcriptions not yet delivered, chained so they deliver in order. */
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly abort = new AbortController();

  constructor(private readonly deps: DictationDeps) {}

  get active(): boolean {
    return !this.stopped;
  }

  start(): void {
    this.open();
  }

  /** Ends the session from outside. Idempotent; never reports `onEnded`. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.closeMic();
    this.abort.abort();
  }

  /** Closes the mic until `resume()`. Pieces already captured still arrive. */
  pause(): void {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.closeMic();
    this.report();
  }

  resume(): void {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    this.open();
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

  private report(): void {
    if (this.stopped) return;
    this.deps.onState(this.paused ? 'paused' : this.pending > 0 ? 'transcribing' : 'listening');
  }

  private open(): void {
    if (this.stopped || this.paused) return;
    // A fresh endpointer per open: it re-calibrates the room, and its silence
    // clock starts over, so time spent paused is not counted as silence.
    const endpointer = new Endpointer({ rate: this.deps.rate, ...this.deps.endpointer });
    let dead = false;
    const handle = this.deps.startMic(
      (pcm) => {
        if (dead || this.stopped || this.mic !== handle) return;
        for (const e of endpointer.push(pcm)) {
          if (e.type === 'utterance') this.enqueue(e.samples);
          if (e.type === 'no-speech') {
            dead = true;
            this.end('Stopped dictating after a long silence.');
            return;
          }
        }
      },
      (err) => {
        if (dead || this.mic !== handle) return;
        dead = true;
        this.end(`The microphone stopped: ${err.message}`);
      },
    );
    this.mic = handle;
    this.report();
  }

  private enqueue(samples: Int16Array): void {
    this.pending++;
    this.report();
    // Started now, delivered in order: the request is in flight while the
    // previous one finishes, and only the hand-off waits its turn.
    const text = this.deps.transcribe(samples, this.abort.signal);
    // Marked handled now: it may reject while an earlier piece is still being
    // delivered, before the chain below awaits it — an unhandled rejection.
    text.catch(() => undefined);
    this.queue = this.queue.then(async () => {
      try {
        const raw = await text;
        this.failures = 0;
        if (this.stopped) return;
        const heard = spokenText(raw);
        if (heard) this.deps.onText(heard);
        else if (raw.trim()) speechLog('dictate:noise', { text: raw.trim() });
      } catch (err) {
        if (this.stopped) return;
        this.failures++;
        const message = err instanceof Error ? err.message : String(err);
        if (this.failures >= MAX_DICTATION_FAILURES) {
          this.end(`Transcription keeps failing: ${message}`);
          return;
        }
        this.deps.onError(`Could not transcribe that: ${message}`);
      } finally {
        this.pending--;
        this.report();
      }
    });
  }
}
