import type { PolicyDecision, SubPolicy } from './types.js';

type Citations = NonNullable<PolicyDecision['citations']>;

/**
 * Issue #173 sub-policy: require citations for factual claims by default.
 * Retrieval tools (web_read, web_search, file_read_lines, memory.read) and
 * RAG hits register sources in the per-turn ProvenanceStore; the model
 * attaches `[^Sn]` markers to claims it derived from those sources. The
 * SYSTEM prompt's `## Citations` section is gated on this flag and on the
 * model family — `REASONING_FAMILIES` skip the inline-marker instruction
 * to avoid conflict with their existing "don't narrate" guidance.
 */
export const citationsPolicy: SubPolicy<Citations> = () => ({
  requireForFactualClaims: true,
  reason: 'issue-173-default-on',
});
