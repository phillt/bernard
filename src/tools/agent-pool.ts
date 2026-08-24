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
 * Non-finite values (`NaN`, `Infinity`) are ignored and the current cap is
 * preserved. Finite non-integers are floored, and the result is clamped to
 * `[1, MAX_CONCURRENT_AGENTS_LIMIT]`. The applied value is returned so callers
 * (config loader, REPL prompt, CLI) can report what was actually set.
 */
export function setMaxConcurrentAgents(n: number): number {
  if (!Number.isFinite(n)) return maxConcurrentAgents;
  const floored = Math.floor(n);
  maxConcurrentAgents = Math.max(1, Math.min(MAX_CONCURRENT_AGENTS_LIMIT, floored));
  return maxConcurrentAgents;
}

/** Options for {@link acquireSlot}. */
export interface AcquireSlotOptions {
  /**
   * Bypass the cap for a helper spawned *inside* a dispatch that already holds a
   * slot — today only the MCP delegate helper (`src/tools/delegate.ts`).
   *
   * Without this, giving sub-agents `delegate_*` tools (#305) starves them: the
   * cap counts sub-agents and helpers in one flat pool, so N parallel
   * sub-agents at the cap leave nothing for the helper each needs, `acquireSlot`
   * returns `null`, and the delegate call degrades to an error string — the
   * sub-agent silently loses MCP access exactly when fan-out is highest.
   *
   * Safe because the parent dispatch is already counted, the helper is
   * short-lived and scoped to one server, and nesting is bounded at one level:
   * a helper's registry is `{…oneServersTools, ask_user}` and can never contain
   * a `delegate_*` tool, so it cannot spawn a helper of its own.
   *
   * Still increments `activeAgentCount`, so `releaseSlot()` stays symmetric and
   * {@link getActiveCount} reflects real in-flight work.
   */
  nested?: boolean;
}

/**
 * Attempts to acquire a slot in the shared agent/task concurrency pool.
 * @returns The assigned agent ID, or `null` if the pool is at capacity.
 */
export function acquireSlot(opts: AcquireSlotOptions = {}): { id: number } | null {
  if (!opts.nested && activeAgentCount >= maxConcurrentAgents) return null;
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
