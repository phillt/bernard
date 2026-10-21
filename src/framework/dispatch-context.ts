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

/**
 * Where in the work this code is running: the turn, the dispatch, and the tool
 * call. One store rather than three, because the point is that every log line
 * can be placed in the tree, and a tree edge is a relation BETWEEN levels — a
 * dispatch records the tool call that spawned it, which only a store holding
 * both can see at the moment the child starts.
 *
 * Each level is entered with a COPY of the enclosing store, so a nested scope
 * inherits everything above it and overrides only its own level.
 */
export interface DispatchContext {
  /** The REPL turn, cron run or script invocation this work belongs to. */
  turnId?: string;
  dispatchId?: string;
  /**
   * The dispatch that spawned this one, if any — captured at entry from the
   * enclosing context. A sub-agent / PAC phase / tool-wrapper dispatch nested
   * inside the main agent's dispatch carries the parent's id as its tree edge.
   * `undefined` for a top-level dispatch.
   */
  parentDispatchId?: string;
  /** The tool call that spawned this dispatch, so a child hangs off its call. */
  parentToolCallId?: string;
  /** The tool call currently executing in this dispatch, if any. */
  toolCallId?: string;
}

const storage = new AsyncLocalStorage<DispatchContext>();

export function runWithDispatchId<T>(dispatchId: string, fn: () => T): T {
  // Capture the enclosing dispatch and tool call as the parent before we swap
  // the active context to this dispatch. Nested `runAgent` calls run inside the
  // parent's tool `execute`, so this reads both edges.
  const outer = storage.getStore();
  return storage.run(
    {
      turnId: outer?.turnId,
      dispatchId,
      parentDispatchId: outer?.dispatchId,
      parentToolCallId: outer?.toolCallId,
    },
    fn,
  );
}

/** Runs `fn` as one tool call of the current dispatch. */
export function runWithToolCall<T>(toolCallId: string, fn: () => T): T {
  return storage.run({ ...storage.getStore(), toolCallId }, fn);
}

/** Runs `fn` as one turn. A new turn starts a fresh tree, so nothing is inherited. */
export function runWithTurn<T>(turnId: string, fn: () => T): T {
  return storage.run({ turnId }, fn);
}

export function getCurrentDispatchId(): string | undefined {
  return storage.getStore()?.dispatchId;
}

/**
 * Both dispatch ids in one `getStore()` read. `dispatchId`/`parentDispatchId` are
 * `undefined` outside any dispatch (off-loop pre-turn calls) — the correct value,
 * so telemetry can capture the trace edge centrally without each caller stamping.
 */
export function getCurrentDispatchIds(): { dispatchId?: string; parentDispatchId?: string } {
  const store = storage.getStore();
  return { dispatchId: store?.dispatchId, parentDispatchId: store?.parentDispatchId };
}

/** The whole context, with unset levels omitted; `undefined` outside any scope. */
export function getTraceContext(): DispatchContext | undefined {
  const store = storage.getStore();
  if (!store) return undefined;
  const out: DispatchContext = {};
  for (const [k, v] of Object.entries(store) as [keyof DispatchContext, string | undefined][]) {
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
