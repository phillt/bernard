import type { PolicyDecision, SubPolicy } from './types.js';

type Concise = NonNullable<PolicyDecision['concise']>;

/**
 * Concise-by-default response shaping (issue #175). Reads
 * `config.conciseMode`; when on, `buildMainSystemPrompt` injects the
 * `CONCISE_PROMPT` block instructing the model to keep responses to the
 * smallest sufficient size. `maxBullets` / `maxLines` are advisory caps that
 * appear in the prompt — the model self-enforces, with a tool-wrapper-side
 * defense-in-depth cap on the `reasoning` array in `wrapWrapperResult`.
 *
 * Reason codes: `config-on` | `config-off`.
 */
export const concisePolicy: SubPolicy<Concise> = (input) => {
  // Treat undefined as on so partially-constructed configs (legacy serialized
  // prefs, scoped test fixtures) match `DEFAULT_CONCISE_MODE` instead of
  // silently disabling concision.
  if (input.config.conciseMode !== false) {
    return {
      enabled: true,
      maxBullets: 6,
      maxLines: 12,
      reason: 'config-on',
    };
  }
  return { enabled: false, reason: 'config-off' };
};
