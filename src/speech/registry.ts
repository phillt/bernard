import { getServiceKey } from '../config.js';
import { elevenLabs } from './elevenlabs.js';
import type { Pcm, SpeechProvider } from './types.js';
import type { SpeechProviderId } from './ids.js';

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
): (text: string, opts: { voice?: string; signal: AbortSignal }) => Promise<Pcm> {
  return async (text, opts) => {
    const run = SPEECH_PROVIDERS[id].synthesize;
    const key = speechProviderKey(id);
    const problem = speechProviderUnavailable(id, 'synthesize');
    if (problem || !run || key === undefined) throw new Error(problem ?? 'Unavailable.');
    return run(text, key, opts);
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
    if (problem || !run || key === undefined) throw new Error(problem ?? 'Unavailable.');
    return run(audio, key, { signal });
  };
}
