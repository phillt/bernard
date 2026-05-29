import type { PolicyDecision, SubPolicy } from './types.js';

type Citations = NonNullable<PolicyDecision['citations']>;

/**
 * Stub sub-policy — issue #173 will require citations for factual claims
 * surfaced from web/RAG sources, gated here based on `userInput` shape
 * (e.g. questions vs. casual replies).
 */
export const citationsPolicy: SubPolicy<Citations> = () => ({
  requireForFactualClaims: false,
  reason: 'pending-issue-173',
});
