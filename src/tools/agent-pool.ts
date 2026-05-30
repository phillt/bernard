/** Default ceiling on concurrent agents/tasks when no config has loaded. */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 4;
/** Hard upper bound that the user-configurable cap may not exceed (issue #133). */
export const MAX_CONCURRENT_AGENTS_LIMIT = 20;

let maxConcurrentAgents = DEFAULT_MAX_CONCURRENT_AGENTS;
let activeAgentCount = 0;
let nextAgentId = 1;

/** Returns the live cap on concurrent agents/tasks (mutated by {@link setMaxConcurrentAgents}). */
export function getMaxConcurrentAgents(): number {
  return maxConcurrentAgents;
}

/**
 * Sets the live cap on concurrent agents/tasks.
 *
 * Non-integer, non-finite, or out-of-range values are clamped to
 * `[1, MAX_CONCURRENT_AGENTS_LIMIT]`. The clamped value is returned so callers
 * (config loader, REPL prompt, CLI) can report what was actually applied.
 */
export function setMaxConcurrentAgents(n: number): number {
  if (!Number.isFinite(n)) return maxConcurrentAgents;
  const floored = Math.floor(n);
  maxConcurrentAgents = Math.max(1, Math.min(MAX_CONCURRENT_AGENTS_LIMIT, floored));
  return maxConcurrentAgents;
}

/**
 * Attempts to acquire a slot in the shared agent/task concurrency pool.
 * @returns The assigned agent ID, or `null` if the pool is at capacity.
 */
export function acquireSlot(): { id: number } | null {
  if (activeAgentCount >= maxConcurrentAgents) return null;
  activeAgentCount++;
  return { id: nextAgentId++ };
}

/** Releases a slot back to the concurrency pool. */
export function releaseSlot(): void {
  if (activeAgentCount > 0) activeAgentCount--;
}

/**
 * Returns the number of currently active agents/tasks.
 * @internal Exported for testing only.
 */
export function getActiveCount(): number {
  return activeAgentCount;
}

/**
 * Resets the pool state (active count, ID sequence, and cap).
 * @internal Exported for testing only.
 */
export function _resetPool(): void {
  activeAgentCount = 0;
  nextAgentId = 1;
  maxConcurrentAgents = DEFAULT_MAX_CONCURRENT_AGENTS;
}
