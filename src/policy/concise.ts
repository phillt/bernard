import type { PolicyDecision, SubPolicy } from './types.js';

type Concise = NonNullable<PolicyDecision['concise']>;

/**
 * Stub sub-policy — issue #175 will gate concise-mode and pick max line /
 * bullet counts here. Today the agent's own `BASE_SYSTEM_PROMPT` carries the
 * concise guidance, so this sub-policy is inert.
 */
export const concisePolicy: SubPolicy<Concise> = () => ({
  enabled: false,
  reason: 'pending-issue-175',
});
