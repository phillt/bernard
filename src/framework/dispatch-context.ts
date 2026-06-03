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
}

const storage = new AsyncLocalStorage<DispatchContext>();

export function runWithDispatchId<T>(dispatchId: string, fn: () => T): T {
  return storage.run({ dispatchId }, fn);
}

export function getCurrentDispatchId(): string | undefined {
  return storage.getStore()?.dispatchId;
}
