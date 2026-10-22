import type { VoiceTuning } from './tuning.js';
/**
 * The speech-vendor contract. A vendor offers synthesis, transcription or both;
 * each capability is optional so a TTS-only or STT-only service fits the same
 * shape, and swapping vendors is a registry edit rather than a call-site edit.
 */

/** Raw signed 16-bit little-endian mono PCM, at a stated rate. */
export interface Pcm {
  samples: Int16Array;
  rate: number;
}

export interface SynthesizeOptions {
  /** Vendor voice id; the vendor's default when absent. */
  voice?: string;
  /** Pace multiplier, 1 being the voice's own; the vendor clamps its range. */
  speed?: number;
  /** How the voice is tuned; absent fields are the voice's own. */
  tuning?: VoiceTuning;
  signal?: AbortSignal;
  /** How long the request may take; the vendor module's default when absent. */
  timeoutMs?: number;
}

export interface TranscribeOptions {
  signal?: AbortSignal;
  /** How long the request may take; the vendor module's default when absent. */
  timeoutMs?: number;
}

export interface SpeechProvider {
  /** Registry id, and the name its key is stored under in `keys.json`. */
  id: string;
  label: string;
  /** The `SERVICE_KEY_ENV_VARS` name, when the vendor needs a key. */
  keyName?: string;
  synthesize?(text: string, apiKey: string, opts?: SynthesizeOptions): Promise<Pcm>;
  transcribe?(audio: Pcm, apiKey: string, opts?: TranscribeOptions): Promise<string>;
  /** The voices this key can use, for a picker. */
  listVoices?(apiKey: string): Promise<VoiceInfo[]>;
}

/** One voice a vendor offers, as a picker shows it. */
export interface VoiceInfo {
  id: string;
  name: string;
  /** Accent, age, gender, use — whatever the vendor tags it with, as words. */
  traits: string[];
  /** `premade`, `cloned`, `generated`, `professional`… as the vendor says. */
  category?: string;
}

/**
 * A vendor call that failed, carrying what the vendor said. A bare status line
 * ("401") sends the reader to the wrong fix; the body usually names the right
 * one ("invalid_api_key", "quota_exceeded").
 */
export class SpeechProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${provider} returned ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'SpeechProviderError';
  }
}
