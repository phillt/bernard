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
/**
 * How long one request may take, body included. The session's own signal only
 * fires on Esc, so without this a service that accepts the POST and never
 * answers holds talk mode on "transcribing" forever.
 */
export const ELEVENLABS_REQUEST_TIMEOUT_MS = 60_000;
/**
 * The shape of an ElevenLabs voice id. `voiceVoice` is shared with the local
 * engines, where it holds a name like `Daniel` or `en-us+f3`; sent as a voice
 * id, that fails every utterance. Anything else falls back to the default.
 */
const VOICE_ID = /^[A-Za-z0-9]{20}$/;

export function elevenLabsVoice(voice: string | undefined): string {
  const named = voice?.trim() ?? '';
  return VOICE_ID.test(named) ? named : ELEVENLABS_DEFAULT_VOICE;
}

/** The caller's signal plus the request clock, with a timeout that says so. */
async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  opts: { signal?: AbortSignal; timeoutMs?: number },
  read: (res: Response) => Promise<unknown>,
): Promise<unknown> {
  const { signal } = opts;
  const ms = opts.timeoutMs ?? ELEVENLABS_REQUEST_TIMEOUT_MS;
  const clock = AbortSignal.timeout(ms);
  const combined = signal ? AbortSignal.any([signal, clock]) : clock;
  try {
    const res = await fetchImpl(url, { ...init, signal: combined });
    if (!res.ok) throw await failure(res);
    return await read(res);
  } catch (err) {
    if (clock.aborted && !signal?.aborted) {
      throw new Error(`ElevenLabs did not answer within ${ms / 1000} s (timed out).`);
    }
    throw err;
  }
}

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
  const voice = encodeURIComponent(elevenLabsVoice(opts.voice));
  const buf = (await request(
    fetchImpl,
    `${ELEVENLABS_API}/v1/text-to-speech/${voice}?output_format=pcm_${TTS_RATE}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: ELEVENLABS_TTS_MODEL }),
    },
    opts,
    (res) => res.arrayBuffer(),
  )) as ArrayBuffer;
  const bytes = new Uint8Array(buf);
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
  // Scribe annotates coughs, clicks and laughter as `[coughs]` by default; a
  // transcript is what was said, so ask for words only. The talk loop strips
  // bracketed tags as well, since the next vendor may not have this switch.
  form.append('tag_audio_events', 'false');
  form.append(
    'file',
    new Blob([new Uint8Array(pcmToWav(audio.samples, audio.rate))], { type: 'audio/wav' }),
    'speech.wav',
  );
  const body = (await request(
    fetchImpl,
    `${ELEVENLABS_API}/v1/speech-to-text`,
    { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form },
    opts,
    (res) => res.json(),
  )) as { text?: unknown };
  return typeof body.text === 'string' ? body.text.trim() : '';
}

export const elevenLabs: SpeechProvider = {
  id: 'elevenlabs',
  label: 'ElevenLabs',
  keyName: 'elevenlabs',
  synthesize: (text, key, opts) => synthesize(text, key, opts),
  transcribe: (audio, key, opts) => transcribe(audio, key, opts),
};
