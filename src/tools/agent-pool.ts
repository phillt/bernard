import { AsyncLocalStorage } from 'node:async_hooks';

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

/**
 * Tracks whether the current async path already holds a pool slot (#317).
 *
 * **This is deliberately NOT the dispatch ALS.** `runWithDispatchId`
 * (`framework/dispatch-context.ts`) is established for every dispatch, and the
 * AI SDK invokes `tool.execute` from inside that same async context — so every
 * ordinary sub-agent/task/specialist call already runs with a dispatch id.
 * Keying nesting on `getCurrentDispatchId() !== undefined` would therefore
 * exempt every acquire in the product, which is the pool's entire purpose.
 * Holding a slot is a different fact from being inside a dispatch, and it needs
 * its own store.
 */
const slotHeld = new AsyncLocalStorage<true>();

/** Outcome of {@link withSlot}: either the pool was full, or `fn` ran. */
export type SlotOutcome<T> = { acquired: false } | { acquired: true; value: T };

/**
 * Runs `fn` holding a slot in the shared agent/task concurrency pool, releasing
 * it on every exit path.
 *
 * Owning acquire *and* release is the point (#317): all five call sites used to
 * pair them by hand, and `releaseSlot` takes no argument, so a missed or
 * doubled release silently skews the count rather than throwing.
 *
 * **Nesting is automatic.** An acquire from inside a slot-holder is free,
 * because the enclosing dispatch is already counted. That was previously an
 * opt-in `nested: true` flag which only the MCP delegate helper passed —
 * correct for the one path that tripped over it, and a trap for every future
 * nested acquirer, since the flag's absence is silently the wrong answer. A
 * tool-wrapper holding a slot can reach `agent` / `task` / `specialist_run`,
 * so more such paths already exist.
 *
 * Why nesting must be free at all: the cap counts parents and helpers in one
 * flat pool, so N parallel sub-agents at the cap leave nothing for the helper
 * each one needs, and the delegate call degrades to an error string — silently
 * losing MCP access exactly when fan-out is highest (#305).
 *
 * Two consequences, both deliberate and unchanged:
 * - {@link getActiveCount} may exceed `maxConcurrentAgents` (nested slots are
 *   still counted, so release stays symmetric), so a consumer treating the
 *   active count as `<= cap` is wrong.
 * - The cap bounds nesting DEPTH, not WIDTH: k parallel delegate calls from
 *   each of N capped parents put `N + N*k` dispatches in flight.
 *
 * Returns a discriminated result rather than throwing, because the five call
 * sites report exhaustion in four different shapes (a bare string, an `err()`
 * envelope, a `pool_exhausted` code, and one that cannot happen) and their
 * exact wording is asserted by tests.
 */
export async function withSlot<T>(
  fn: (slot: { id: number }) => Promise<T>,
): Promise<SlotOutcome<T>> {
  const nested = slotHeld.getStore() === true;
  if (!nested && activeAgentCount >= maxConcurrentAgents) return { acquired: false };
  activeAgentCount++;
  const slot = { id: nextAgentId++ };
  try {
    const value = await slotHeld.run(true, () => fn(slot));
    return { acquired: true, value };
  } finally {
    if (activeAgentCount > 0) activeAgentCount--;
  }
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
