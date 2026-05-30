import type { PolicyDecision, SubPolicy } from './types.js';

type Evidence = NonNullable<PolicyDecision['evidence']>;

/**
 * Issue #141 sub-policy: require evidence pointers for verified claims by
 * default. Tool calls register `kind: 'tool-result'` sources in the per-turn
 * ProvenanceStore (via `augmentTools`); the SYSTEM prompt's `## Evidence
 * Pointers` section is gated on this flag and on the model family
 * (`REASONING_FAMILIES` skip the inline-marker instruction for the same
 * reason citations do).
 */
export const evidencePolicy: SubPolicy<Evidence> = () => ({
  requireForVerifiedClaims: true,
  reason: 'issue-141-default-on',
});
