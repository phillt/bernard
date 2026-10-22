import { getServiceKey } from '../config.js';
import { elevenLabs } from './elevenlabs.js';
import type { Pcm, SpeechProvider, VoiceInfo } from './types.js';
import type { VoiceTuning } from './tuning.js';
import type { SpeechProviderId } from './ids.js';
import { errorFields, previewText, speechLog } from './log.js';

export { SPEECH_PROVIDER_IDS, isSpeechProviderId, type SpeechProviderId } from './ids.js';

/**
 * Every speech vendor Bernard can use, keyed by id. The swap point: a new
 * vendor is one entry here and one file beside `elevenlabs.ts`, and nothing
 * that speaks or listens names a vendor directly.
 */
export const SPEECH_PROVIDERS: Record<SpeechProviderId, SpeechProvider> = {
  elevenlabs: elevenLabs,
};

/** The vendor's key, or `undefined` when it needs one and none is stored. */
export function speechProviderKey(id: SpeechProviderId): string | undefined {
  const p = SPEECH_PROVIDERS[id];
  return p.keyName ? getServiceKey(p.keyName) : '';
}

/**
 * The sentence to show when a vendor cannot be used, or `null` when it can.
 * Names the exact command, because "no key" alone sends nobody anywhere.
 */
export function speechProviderUnavailable(
  id: SpeechProviderId,
  need: 'synthesize' | 'transcribe',
): string | null {
  const p = SPEECH_PROVIDERS[id];
  if (!p[need]) return `${p.label} cannot ${need === 'synthesize' ? 'speak' : 'transcribe'}.`;
  if (speechProviderKey(id) === undefined) {
    return `No ${p.label} API key. Add one with \`bernard add-key ${p.keyName} <key>\` or /voice.`;
  }
  return null;
}

/**
 * A synthesizer for `VoiceService`, bound to a vendor. The key is read at CALL
 * time rather than captured, so a key added through `/voice` mid-session takes
 * effect on the next utterance without rebuilding the service.
 */
export function synthesizerFor(
  id: SpeechProviderId,
): (
  text: string,
  opts: { voice?: string; speed?: number; tuning?: VoiceTuning; signal: AbortSignal },
) => Promise<Pcm> {
  return async (text, opts) => {
    const run = SPEECH_PROVIDERS[id].synthesize;
    const key = speechProviderKey(id);
    const problem = speechProviderUnavailable(id, 'synthesize');
    if (problem || !run || key === undefined) {
      speechLog('tts:unavailable', { provider: id, error: problem ?? 'Unavailable.' });
      throw new Error(problem ?? 'Unavailable.');
    }
    const t0 = Date.now();
    speechLog('tts:request', {
      provider: id,
      voice: opts.voice?.trim() ? opts.voice : null,
      chars: text.length,
      text: previewText(text),
    });
    try {
      const pcm = await run(text, key, opts);
      speechLog('tts:response', {
        provider: id,
        ms: Date.now() - t0,
        samples: pcm.samples.length,
        rate: pcm.rate,
        seconds: Math.round((pcm.samples.length / pcm.rate) * 100) / 100,
      });
      return pcm;
    } catch (err) {
      speechLog(opts.signal.aborted ? 'tts:aborted' : 'tts:error', {
        provider: id,
        ms: Date.now() - t0,
        ...errorFields(err),
      });
      throw err;
    }
  };
}

/** The same, for transcription. */
export function transcriberFor(
  id: SpeechProviderId,
): (audio: Pcm, signal: AbortSignal) => Promise<string> {
  return async (audio, signal) => {
    const run = SPEECH_PROVIDERS[id].transcribe;
    const key = speechProviderKey(id);
    const problem = speechProviderUnavailable(id, 'transcribe');
    if (problem || !run || key === undefined) {
      speechLog('stt:unavailable', { provider: id, error: problem ?? 'Unavailable.' });
      throw new Error(problem ?? 'Unavailable.');
    }
    const t0 = Date.now();
    const seconds = Math.round((audio.samples.length / audio.rate) * 100) / 100;
    speechLog('stt:request', {
      provider: id,
      seconds,
      samples: audio.samples.length,
      rate: audio.rate,
    });
    try {
      const text = await run(audio, key, { signal });
      speechLog('stt:response', {
        provider: id,
        ms: Date.now() - t0,
        chars: text.length,
        text: previewText(text),
      });
      return text;
    } catch (err) {
      speechLog(signal.aborted ? 'stt:aborted' : 'stt:error', {
        provider: id,
        ms: Date.now() - t0,
        seconds,
        ...errorFields(err),
      });
      throw err;
    }
  };
}

/**
 * The voices a vendor offers this key, for the `/voice` picker, or `null` when
 * the vendor has no list to give. Throws what the vendor said, so a key
 * without permission to list voices can be told so by name.
 */
export async function voicesFor(id: SpeechProviderId): Promise<VoiceInfo[] | null> {
  const p = SPEECH_PROVIDERS[id];
  const key = speechProviderKey(id);
  if (!p.listVoices || key === undefined) return null;
  const t0 = Date.now();
  try {
    const voices = await p.listVoices(key);
    speechLog('voices:list', { provider: id, ms: Date.now() - t0, count: voices.length });
    return voices;
  } catch (err) {
    speechLog('voices:error', { provider: id, ms: Date.now() - t0, ...errorFields(err) });
    throw err;
  }
}
