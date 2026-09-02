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

/** Runs `fn` holding a slot; the shared body of the two public entry points. */
async function runHoldingSlot<T>(fn: (slot: { id: number }) => Promise<T>): Promise<T> {
  activeAgentCount++;
  const slot = { id: nextAgentId++ };
  try {
    return await slotHeld.run(true, () => fn(slot));
  } finally {
    if (activeAgentCount > 0) activeAgentCount--;
  }
}

/**
 * Runs `fn` holding a slot in the shared agent/task concurrency pool, releasing
 * it on every exit path. Calls `onExhausted` instead when the pool is full.
 *
 * Owning acquire *and* release is the point (#317): six call sites used to pair
 * them by hand, and `releaseSlot` takes no argument, so a missed or doubled
 * release skewed the count silently rather than throwing.
 *
 * **Nesting is automatic.** An acquire from inside a slot-holder is free,
 * because the enclosing dispatch is already counted — tracked by {@link slotHeld}
 * rather than an opt-in flag the caller had to remember, whose absence was
 * silently the wrong answer. That matters beyond the one path it was added for:
 * a tool-wrapper holding a slot can reach `agent` / `task` / `specialist_run`,
 * so more nested acquirers already exist.
 *
 * `onExhausted` is a thunk rather than a discriminated return because the call
 * sites report exhaustion in four genuinely different shapes — a bare string, an
 * `err()` envelope, a `pool_exhausted` `WrapperResult`, a toast — each dictated
 * by its tool's own return contract, with wording tests assert verbatim. They
 * already converge where it matters: `error-taxonomy.ts` classifies every one of
 * them as `pool_exhausted`.
 *
 * Two consequences, both deliberate:
 * - {@link getActiveCount} may exceed `maxConcurrentAgents` (nested slots are
 *   still counted, so release stays symmetric), so a consumer treating the
 *   active count as `<= cap` is wrong. The overshoot is no longer bounded at
 *   +1: the exempt set grew from one declared path to every dispatch below a
 *   slot-holder, at any depth.
 * - The cap bounds nesting DEPTH, not WIDTH: k parallel delegate calls from
 *   each of N capped parents put `N + N*k` dispatches in flight.
 */
export async function withSlot<T>(
  fn: (slot: { id: number }) => Promise<T>,
  onExhausted: () => T,
): Promise<T> {
  const nested = slotHeld.getStore() === true;
  if (!nested && activeAgentCount >= maxConcurrentAgents) return onExhausted();
  return runHoldingSlot(fn);
}

/**
 * Runs `fn` holding a slot, never blocking on the cap.
 *
 * For work that must not be starved even when its caller holds no slot of its
 * own — today only the per-server MCP delegate helper (#305). {@link withSlot}'s
 * ALS covers a helper spawned by a *sub-agent*, which does hold one; it does not
 * cover a `delegate_*` call issued by the **main agent**, which holds no pool
 * slot at all. Routing that through the capped path would let four parallel
 * sub-agents starve main's own MCP access — the exact failure #305 fixed, and a
 * regression #317 would otherwise have introduced while removing the old
 * unconditional `nested: true` bypass.
 *
 * Losing MCP is worse than exceeding the cap, which is the whole argument; the
 * slot is still counted, so release stays symmetric.
 */
export async function withUncappedSlot<T>(fn: (slot: { id: number }) => Promise<T>): Promise<T> {
  return runHoldingSlot(fn);
}

/**
 * A one-line statement of how much of the concurrency budget is in use, for
 * appending to a dispatch's result.
 *
 * The model has no other way to know. `withSlot` returns `pool_exhausted`
 * rather than queueing, so a fan-out wider than the cap silently loses work —
 * and nothing in the tool schema or the system prompt says what the cap is.
 * Telling it at the point of use, every time, is the only place the number is
 * both accurate and relevant: the cap is user-configurable and can change
 * mid-session (`/agent-options`, profile switch), so a figure baked into the
 * prompt would be a guess that also changes the prompt-cache prefix.
 *
 * **Call this AFTER the dispatch's own slot is released** — i.e. outside the
 * `withSlot` callback. Called from inside, it counts the caller's own slot as
 * busy and understates the free count by one, which is the opposite of the
 * decision the model is about to make.
 */
export function slotStatusLine(): string {
  const max = getMaxConcurrentAgents();
  const free = Math.max(0, max - getActiveCount());
  const advice =
    free > 0
      ? 'dispatch more in one response when the work is independent'
      : 'wait for one to finish before dispatching another';
  return `[agent slots: ${free} of ${max} free — ${advice}]`;
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
