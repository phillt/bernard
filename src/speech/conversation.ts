import { Endpointer, type EndpointerOptions } from './endpointer.js';
import type { MicHandle } from './recorder.js';
import { speechLog } from './log.js';

/**
 * What the person actually SAID, with the sounds around it removed. Speech-to-
 * text vendors annotate non-speech audio in square brackets (ElevenLabs writes
 * `[coughs]`, `[clicking]`, `[laughter]`), and a cough or a mouse click picked
 * up by an open mic came back as a transcript of nothing but that tag — which
 * then started a turn, or was handed to the running one as a follow-up.
 * Returns `''` when no word survives, which every caller already treats as
 * "nothing intelligible". Brackets only: parentheses are ordinary speech.
 */
export function spokenText(raw: string): string {
  const text = raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : '';
}

/**
 * The hands-free loop: listen → transcribe → think → speak → listen. React-free
 * and vendor-free — every effect is injected — so the state machine is tested
 * with fakes and the REPL only supplies the four doors.
 *
 * **Half-duplex.** The microphone is closed while Bernard is talking, which is
 * what stops it transcribing its own voice. Interrupting by speaking over it
 * (barge-in) needs echo cancellation and is a separate change.
 *
 * **Open while thinking.** A pause to think often ends an utterance before the
 * thought does, so the mic stays open while the turn runs and anything said
 * then is a follow-up — handed to the running turn through `followUp`, the
 * same door typed mid-turn text uses. Bernard is silent while thinking, so
 * there is no echo to hear. A follow-up the turn could not take is held and
 * becomes the next turn, after the reply is spoken.
 */

export type TalkState = 'listening' | 'transcribing' | 'thinking' | 'speaking';

export interface TalkDeps {
  rate: number;
  startMic(onChunk: (pcm: Int16Array) => void, onError: (err: Error) => void): MicHandle;
  transcribe(samples: Int16Array, signal: AbortSignal): Promise<string>;
  /** Runs one turn; resolves to the reply to speak, or null for nothing. */
  submit(text: string): Promise<string | null>;
  /**
   * Offers something said mid-turn to the running turn. `true` means it was
   * taken; `false` (or no `followUp` at all) means it waits for the next turn.
   */
  followUp?(text: string): boolean;
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
  /** The mic kept open while a turn runs, for follow-ups. */
  private followMic: MicHandle | null = null;
  /** Follow-up transcriptions still in flight. */
  private readonly inflight = new Set<Promise<void>>();
  /** Follow-ups the running turn could not take; they become the next turn. */
  private pending: string[] = [];
  private turnRunning = false;
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

  /**
   * Hands back follow-ups the turn never delivered (the REPL's leftover
   * interjections), so they run as the next turn here rather than as a queued
   * turn whose reply nobody would speak.
   */
  queueFollowUps(texts: readonly string[]): void {
    if (this.stopped) return;
    for (const t of texts) if (t.trim()) this.pending.push(t.trim());
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
    this.closeFollowMic();
  }

  private closeFollowMic(): void {
    this.followMic?.stop();
    this.followMic = null;
  }

  /**
   * Listens for follow-ups while a turn runs. No silence timeout: a long turn
   * is not the user going quiet. A dead mic here is reported, not fatal — the
   * turn is still running and the main mic reopens after it.
   */
  private openFollowMic(): void {
    if (this.stopped) return;
    const endpointer = new Endpointer({
      rate: this.deps.rate,
      ...this.deps.endpointer,
      noSpeechMs: Number.POSITIVE_INFINITY,
    });
    let dead = false;
    const handle = this.deps.startMic(
      (pcm) => {
        if (dead || this.stopped || this.followMic !== handle) return;
        for (const e of endpointer.push(pcm)) {
          if (e.type === 'utterance') this.trackFollowUp(e.samples);
        }
      },
      (err) => {
        if (dead || this.followMic !== handle) return;
        dead = true;
        this.followMic = null;
        this.deps.onError(`The microphone stopped while Bernard was thinking: ${err.message}`);
      },
    );
    this.followMic = handle;
  }

  private trackFollowUp(samples: Int16Array): void {
    const p = this.followUpFrom(samples).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  private async followUpFrom(samples: Int16Array): Promise<void> {
    let text: string;
    try {
      text = await this.deps.transcribe(samples, this.abort.signal);
    } catch (err) {
      if (this.stopped) return;
      this.deps.onError(
        `Could not transcribe that: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (this.stopped) return;
    text = this.heard(text);
    if (!text) return;
    if (this.turnRunning && this.deps.followUp?.(text)) return;
    this.pending.push(text);
  }

  /** `spokenText`, logging what it threw away so a dropped cough is visible. */
  private heard(raw: string): string {
    const text = spokenText(raw);
    if (!text && raw.trim()) speechLog('talk:noise', { text: raw.trim() });
    return text;
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
    text = this.heard(text);
    // Nothing intelligible: listen again rather than start an empty turn.
    if (!text) {
      this.listen();
      return;
    }

    await this.runTurn(text);
  }

  private async runTurn(text: string): Promise<void> {
    if (this.stopped) return;
    this.deps.onState('thinking');
    this.turnRunning = true;
    this.openFollowMic();
    const reply = await this.deps.submit(text).catch(() => null);
    this.turnRunning = false;
    this.closeFollowMic();
    // A follow-up still being transcribed lands in `pending`, not in a turn
    // that has already ended.
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
    if (this.stopped) return;
    if (reply?.trim()) {
      this.deps.onState('speaking');
      await this.deps.speak(reply).catch(() => undefined);
    }
    if (this.stopped) return;
    const next = this.pending.splice(0);
    if (next.length > 0) {
      await this.runTurn(next.join(' '));
      return;
    }
    this.listen();
  }
}
