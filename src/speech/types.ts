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
  signal?: AbortSignal;
}

export interface TranscribeOptions {
  signal?: AbortSignal;
}

export interface SpeechProvider {
  /** Registry id, and the name its key is stored under in `keys.json`. */
  id: string;
  label: string;
  /** The `SERVICE_KEY_ENV_VARS` name, when the vendor needs a key. */
  keyName?: string;
  synthesize?(text: string, apiKey: string, opts?: SynthesizeOptions): Promise<Pcm>;
  transcribe?(audio: Pcm, apiKey: string, opts?: TranscribeOptions): Promise<string>;
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
