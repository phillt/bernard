/**
 * Decides where an utterance starts and ends, from energy alone. Pure: it is
 * fed PCM and emits events, so it is tested with synthetic audio and no device.
 *
 * Energy rather than a model because it has to run on every 30 ms of a live
 * microphone with nothing to download, and the question it answers is narrow —
 * "has the person stopped talking?" — not "is this speech?". The noise floor
 * is calibrated from the room and keeps adapting during silence, so a fan or a
 * hum raises the bar rather than reading as somebody talking.
 */

export interface EndpointerOptions {
  rate: number;
  /** Silence after speech that ends the utterance. */
  endSilenceMs?: number;
  /** Consecutive loud audio before it counts as speech, so a click is not. */
  startMs?: number;
  /** Audio kept from before speech was detected, so the first word survives. */
  prerollMs?: number;
  /** An utterance is cut here even if the person is still talking. */
  maxUtteranceMs?: number;
  /** How long to listen to nothing before saying so. */
  noSpeechMs?: number;
  /** Speech must be this many times louder than the noise floor. */
  ratio?: number;
  /** Absolute floor, so a dead-silent room does not make breath read as speech. */
  minLevel?: number;
}

export type EndpointEvent =
  | { type: 'speech-start' }
  | { type: 'utterance'; samples: Int16Array }
  | { type: 'no-speech' };

const FRAME_MS = 30;
const CALIBRATION_FRAMES = 10;

export class Endpointer {
  private readonly frame: number;
  private readonly o: Required<EndpointerOptions>;
  private pending: number[] = [];
  private floor = 0;
  private calibrated = 0;
  private voicedRun = 0;
  private silentRun = 0;
  private inSpeech = false;
  private idleFrames = 0;
  private preroll: Int16Array[] = [];
  private utterance: Int16Array[] = [];
  private utteranceFrames = 0;

  constructor(opts: EndpointerOptions) {
    this.o = {
      endSilenceMs: 900,
      startMs: 90,
      prerollMs: 300,
      maxUtteranceMs: 60_000,
      noSpeechMs: 120_000,
      ratio: 3,
      minLevel: 400,
      ...opts,
    };
    this.frame = Math.round((opts.rate * FRAME_MS) / 1000);
  }

  /** Feed samples; returns whatever events they completed, in order. */
  push(samples: Int16Array): EndpointEvent[] {
    const events: EndpointEvent[] = [];
    for (const s of samples) this.pending.push(s);
    while (this.pending.length >= this.frame) {
      const frame = Int16Array.from(this.pending.splice(0, this.frame));
      const e = this.step(frame);
      if (e) events.push(...e);
    }
    return events;
  }

  private frames(ms: number): number {
    return Math.max(1, Math.round(ms / FRAME_MS));
  }

  private step(frame: Int16Array): EndpointEvent[] | null {
    let sum = 0;
    for (const s of frame) sum += s * s;
    const rms = Math.sqrt(sum / frame.length);

    if (this.calibrated < CALIBRATION_FRAMES) {
      this.floor = (this.floor * this.calibrated + rms) / (this.calibrated + 1);
      this.calibrated++;
      this.keepPreroll(frame);
      return null;
    }

    const voiced = rms > Math.max(this.floor * this.o.ratio, this.o.minLevel);

    if (!this.inSpeech) {
      this.keepPreroll(frame);
      if (voiced) {
        this.voicedRun++;
        if (this.voicedRun >= this.frames(this.o.startMs)) {
          this.inSpeech = true;
          this.silentRun = 0;
          this.utterance = [...this.preroll];
          this.utteranceFrames = this.utterance.length;
          this.preroll = [];
          return [{ type: 'speech-start' }];
        }
      } else {
        this.voicedRun = 0;
        // Track the room, slowly, only while nobody is talking.
        this.floor = this.floor * 0.95 + rms * 0.05;
        this.idleFrames++;
        if (this.idleFrames >= this.frames(this.o.noSpeechMs)) {
          this.idleFrames = 0;
          return [{ type: 'no-speech' }];
        }
      }
      return null;
    }

    this.utterance.push(frame);
    this.utteranceFrames++;
    this.silentRun = voiced ? 0 : this.silentRun + 1;
    if (
      this.silentRun >= this.frames(this.o.endSilenceMs) ||
      this.utteranceFrames >= this.frames(this.o.maxUtteranceMs)
    ) {
      return [{ type: 'utterance', samples: this.flush() }];
    }
    return null;
  }

  private keepPreroll(frame: Int16Array): void {
    this.preroll.push(frame);
    const keep = this.frames(this.o.prerollMs);
    if (this.preroll.length > keep) this.preroll.splice(0, this.preroll.length - keep);
  }

  private flush(): Int16Array {
    const total = this.utterance.reduce((n, f) => n + f.length, 0);
    const out = new Int16Array(total);
    let at = 0;
    for (const f of this.utterance) {
      out.set(f, at);
      at += f.length;
    }
    this.utterance = [];
    this.utteranceFrames = 0;
    this.inSpeech = false;
    this.voicedRun = 0;
    this.silentRun = 0;
    this.idleFrames = 0;
    return out;
  }
}
