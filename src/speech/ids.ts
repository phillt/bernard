/**
 * Speech vendor ids, as a zero-import leaf so `config.ts` can validate a stored
 * setting without importing the registry — which imports `config.ts` for keys.
 * `registry.ts` is typed `Record<SpeechProviderId, …>`, so an id here with no
 * entry there is a compile error.
 */
export const SPEECH_PROVIDER_IDS = ['elevenlabs'] as const;
export type SpeechProviderId = (typeof SPEECH_PROVIDER_IDS)[number];
export const DEFAULT_STT_PROVIDER: SpeechProviderId = 'elevenlabs';

export function isSpeechProviderId(v: unknown): v is SpeechProviderId {
  return typeof v === 'string' && (SPEECH_PROVIDER_IDS as readonly string[]).includes(v);
}
