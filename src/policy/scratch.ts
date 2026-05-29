import type { PolicyDecision, SubPolicy } from './types.js';

type Scratch = NonNullable<PolicyDecision['scratch']>;

/**
 * Today: clears plan-store only, every turn. Matches the historical
 * unconditional `planStore.clear()` at the top of `Agent.processInput`.
 * Issue #169 will switch this to a real heuristic (subject change, "new
 * task" detection, etc.) and may set `resetAll: true` to also drop scratch.
 */
export const scratchPolicy: SubPolicy<Scratch> = () => ({
  resetAll: false,
  resetPlanOnly: true,
  reason: 'per-turn-default',
});
