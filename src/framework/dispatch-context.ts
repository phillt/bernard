/**
 * @module framework/dispatch-context
 *
 * AsyncLocalStorage singleton that carries the current dispatch's id across
 * `await` boundaries. Used to correlate `http:request:*` events emitted by the
 * instrumented global `fetch` wrapper back to the `runAgent` invocation that
 * issued them. Read-only outside `runAgent`; the wrapper just reads the
 * current context to tag log entries.
 *
 * Behavior when no dispatch is active (e.g. catalog refresh at startup, MCP
 * connect, REPL helpers): `getCurrentDispatchId()` returns `undefined`, and
 * the wrapper omits the field. That's intentional — those fetches still log,
 * just without correlation.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface DispatchContext {
  dispatchId: string;
  /**
   * The dispatch that spawned this one, if any — captured at entry from the
   * enclosing context. Powers the hierarchical telemetry trace (a sub-agent /
   * PAC phase / tool-wrapper dispatch nested inside the main agent's dispatch
   * carries the parent's id as its tree edge). `undefined` for a top-level
   * dispatch (the main agent, or an off-loop call with no active dispatch).
   */
  parentDispatchId?: string;
}

const storage = new AsyncLocalStorage<DispatchContext>();

export function runWithDispatchId<T>(dispatchId: string, fn: () => T): T {
  // Capture the enclosing dispatch (if any) as the parent before we swap the
  // active context to this dispatch. Nested `runAgent` calls (sub-agents,
  // PAC phases, tool-wrappers) run inside the parent's ALS, so this reads the
  // parent's id and records the tree edge.
  const parentDispatchId = storage.getStore()?.dispatchId;
  return storage.run({ dispatchId, parentDispatchId }, fn);
}

export function getCurrentDispatchId(): string | undefined {
  return storage.getStore()?.dispatchId;
}

/** The dispatch that spawned the current one, or `undefined` at the top level. */
export function getCurrentParentDispatchId(): string | undefined {
  return storage.getStore()?.parentDispatchId;
}
