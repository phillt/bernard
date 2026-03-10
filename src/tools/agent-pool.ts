export const MAX_CONCURRENT_AGENTS = 4;

let activeAgentCount = 0;
let nextAgentId = 1;

/**
 * Attempts to acquire a slot in the shared agent/task concurrency pool.
 * @returns The assigned agent ID, or `null` if the pool is at capacity.
 */
export function acquireSlot(): { id: number } | null {
  if (activeAgentCount >= MAX_CONCURRENT_AGENTS) return null;
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
 * Resets the pool state (active count and ID sequence).
 * @internal Exported for testing only.
 */
export function _resetPool(): void {
  activeAgentCount = 0;
  nextAgentId = 1;
}
