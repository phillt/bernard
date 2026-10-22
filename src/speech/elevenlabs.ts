import { pcmToWav } from './wav.js';
import {
  SpeechProviderError,
  type Pcm,
  type SpeechProvider,
  type SynthesizeOptions,
  type TranscribeOptions,
  type VoiceInfo,
} from './types.js';
import { isUntuned, type VoiceTuning } from './tuning.js';

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

/** ElevenLabs accepts a speed of 0.7–1.2 and rejects anything outside it. */
function clampSpeed(speed: number): number {
  return Math.min(1.2, Math.max(0.7, speed));
}

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
  const voiceId = elevenLabsVoice(opts.voice);
  const voice = encodeURIComponent(voiceId);
  const settings = await voiceSettingsFor(voiceId, apiKey, opts, fetchImpl);
  const buf = (await request(
    fetchImpl,
    `${ELEVENLABS_API}/v1/text-to-speech/${voice}?output_format=pcm_${TTS_RATE}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_TTS_MODEL,
        ...(settings ? { voice_settings: settings } : {}),
      }),
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

/**
 * The `voice_settings` to send, or `undefined` to send none and let the voice
 * speak as stored.
 *
 * Sent only when something differs from the voice's own, and then MERGED onto
 * the voice's stored settings: the API takes `voice_settings` as a whole
 * replacement, so sending only `speed` would reset stability and similarity
 * to ElevenLabs' defaults and change how a carefully tuned voice sounds. The
 * stored settings are read once per voice per process. If that read fails
 * (a key without voice permissions), only the fields asked for are sent —
 * the request still works, it just may not keep the voice's own tuning.
 */
async function voiceSettingsFor(
  voiceId: string,
  apiKey: string,
  opts: SynthesizeOptions,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | undefined> {
  const speedSet = opts.speed !== undefined && opts.speed !== 1;
  if (!speedSet && isUntuned(opts.tuning)) return undefined;
  const base = await storedSettings(voiceId, apiKey, opts.signal, fetchImpl);
  return {
    ...base,
    ...tuningFields(opts.tuning),
    ...(speedSet ? { speed: clampSpeed(opts.speed as number) } : {}),
  };
}

/** Bernard's names to ElevenLabs' field names; unset fields are left out. */
function tuningFields(t: VoiceTuning | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (t?.stability !== undefined) out.stability = t.stability;
  if (t?.similarity !== undefined) out.similarity_boost = t.similarity;
  if (t?.style !== undefined) out.style = t.style;
  if (t?.speakerBoost !== undefined) out.use_speaker_boost = t.speakerBoost;
  return out;
}

const storedSettingsCache = new Map<string, Record<string, unknown>>();

async function storedSettings(
  voiceId: string,
  apiKey: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  // Keyed by key AND voice: a voice id means a different voice's settings
  // under another account, and a key changed in `/voice` must not inherit the
  // last one's. Memory only; the key never leaves this map.
  const cacheKey = `${apiKey}\u0000${voiceId}`;
  const cached = storedSettingsCache.get(cacheKey);
  if (cached) return cached;
  try {
    const body = (await request(
      fetchImpl,
      `${ELEVENLABS_API}/v1/voices/${encodeURIComponent(voiceId)}/settings`,
      { method: 'GET', headers: { 'xi-api-key': apiKey } },
      // Short: this sits in front of the first utterance per voice, and a
      // settings read that hangs is worth less than speaking on time.
      { signal, timeoutMs: 3_000 },
      (res) => res.json(),
    )) as Record<string, unknown>;
    const keep: Record<string, unknown> = {};
    for (const k of ['stability', 'similarity_boost', 'style', 'use_speaker_boost', 'speed']) {
      if (body && body[k] !== undefined && body[k] !== null) keep[k] = body[k];
    }
    storedSettingsCache.set(cacheKey, keep);
    return keep;
  } catch {
    if (signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
    return {};
  }
}

/** For tests: forget what was read about each voice. */
export function clearElevenLabsCache(): void {
  storedSettingsCache.clear();
}

/**
 * Every voice this key can use — the stock library plus the account's own
 * clones and generated voices. Needs the key's "Voices: read" permission; a
 * restricted key without it gets a 401 naming `missing_permissions`, which the
 * caller turns into a sentence about the permission rather than a bare status.
 */
export async function listVoices(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VoiceInfo[]> {
  const body = (await request(
    fetchImpl,
    `${ELEVENLABS_API}/v1/voices`,
    { method: 'GET', headers: { 'xi-api-key': apiKey } },
    {},
    (res) => res.json(),
  )) as { voices?: unknown };
  const voices = Array.isArray(body.voices) ? body.voices : [];
  const out: VoiceInfo[] = [];
  for (const v of voices as Record<string, unknown>[]) {
    if (typeof v?.voice_id !== 'string' || typeof v.name !== 'string') continue;
    const labels = v.labels && typeof v.labels === 'object' ? v.labels : {};
    const traits = ['accent', 'age', 'gender', 'description', 'descriptive', 'use_case']
      .map((k) => (labels as Record<string, unknown>)[k])
      .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      .map((t) => t.replace(/_/g, ' '));
    out.push({
      id: v.voice_id,
      name: v.name,
      traits: [...new Set(traits)],
      category: typeof v.category === 'string' ? v.category : undefined,
    });
  }
  return out;
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
  listVoices: (key) => listVoices(key),
};
