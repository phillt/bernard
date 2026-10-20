import { pcmToWav } from './wav.js';
import {
  SpeechProviderError,
  type Pcm,
  type SpeechProvider,
  type SynthesizeOptions,
  type TranscribeOptions,
} from './types.js';

/**
 * ElevenLabs over its REST API with Node's built-in `fetch` — no SDK, so the
 * vendor is one file and leaves no dependency behind when it is swapped out.
 */

export const ELEVENLABS_API = 'https://api.elevenlabs.io';
/** The lowest-latency model; a conversation pays latency on every turn. */
export const ELEVENLABS_TTS_MODEL = 'eleven_flash_v2_5';
export const ELEVENLABS_STT_MODEL = 'scribe_v1';
/** A stock voice every account has, used when `voiceVoice` names none. */
export const ELEVENLABS_DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
/**
 * Raw PCM rather than mp3, so playback needs no decoder: the bytes go straight
 * into `pw-play`/`paplay`/`aplay`, the players warmup already resolves.
 */
const TTS_RATE = 22050;
const MAX_DETAIL_CHARS = 300;

async function failure(res: Response): Promise<SpeechProviderError> {
  let detail = '';
  try {
    detail = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS);
  } catch {
    // The status alone is still worth reporting.
  }
  return new SpeechProviderError('ElevenLabs', res.status, detail);
}

export async function synthesize(
  text: string,
  apiKey: string,
  opts: SynthesizeOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Pcm> {
  // A blank voice means "the default", so an empty string falls through too.
  const named = opts.voice?.trim();
  const voice = encodeURIComponent(
    named !== undefined && named.length > 0 ? named : ELEVENLABS_DEFAULT_VOICE,
  );
  const res = await fetchImpl(
    `${ELEVENLABS_API}/v1/text-to-speech/${voice}?output_format=pcm_${TTS_RATE}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: ELEVENLABS_TTS_MODEL }),
      signal: opts.signal,
    },
  );
  if (!res.ok) throw await failure(res);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Copy into an aligned buffer: an Int16Array view needs an even offset, and
  // a trailing odd byte (never expected, but this is a network body) is dropped.
  const aligned = new Uint8Array(bytes.length & ~1);
  aligned.set(bytes.subarray(0, aligned.length));
  return { samples: new Int16Array(aligned.buffer), rate: TTS_RATE };
}

export async function transcribe(
  audio: Pcm,
  apiKey: string,
  opts: TranscribeOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const form = new FormData();
  form.append('model_id', ELEVENLABS_STT_MODEL);
  form.append(
    'file',
    new Blob([new Uint8Array(pcmToWav(audio.samples, audio.rate))], { type: 'audio/wav' }),
    'speech.wav',
  );
  const res = await fetchImpl(`${ELEVENLABS_API}/v1/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
    signal: opts.signal,
  });
  if (!res.ok) throw await failure(res);
  const body = (await res.json()) as { text?: unknown };
  return typeof body.text === 'string' ? body.text.trim() : '';
}

export const elevenLabs: SpeechProvider = {
  id: 'elevenlabs',
  label: 'ElevenLabs',
  keyName: 'elevenlabs',
  synthesize: (text, key, opts) => synthesize(text, key, opts),
  transcribe: (audio, key, opts) => transcribe(audio, key, opts),
};
