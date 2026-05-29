import type { PolicyDecision, SubPolicy } from './types.js';

type Caching = NonNullable<PolicyDecision['caching']>;

/**
 * Stub sub-policy — issue #171 will introduce LLM-subcall + deterministic
 * tool caching and gate it here based on `userInput` and tool metadata
 * (delivered by #176).
 */
export const cachingPolicy: SubPolicy<Caching> = () => ({
  enabled: false,
  reason: 'pending-issue-171',
});
