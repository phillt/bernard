/**
 * @module tools/write-barrier
 *
 * A read does not overtake a write it was issued to verify.
 *
 * ## The defect
 *
 * A model that writes something and then wants to know it landed emits both
 * calls in ONE step, and the AI SDK runs a step's tool calls in parallel. So the
 * verification read is issued against state from before the write — not
 * sometimes, by construction.
 *
 * Measured across 81 real session logs (6,867 tool calls): **91** reads started
 * while a write was still in flight, and the pairs say exactly what they are —
 * `file_edit_lines` → `file_read_lines`, `calendar_create_event` →
 * `calendar_get_event`, `calendar_update_event` → `calendar_get_events`,
 * `send_message` → `list_messages`. Every one of those verifications read
 * pre-write state.
 *
 * The expensive instance: Bernard sent a family text twice. `send_message` and
 * `list_messages` both started at `01:54:40.748`; the read resolved in 12 ms and
 * the write took 571 ms, so the read could not have seen the message — which is
 * stamped 453 ms after the read returned. The agent concluded the send had
 * failed and re-sent, byte-identical. Both landed (`1904`, `1905`).
 *
 * Within that same session the ordering IS the whole discriminator: four other
 * send→list pairs where the read was issued after the write returned all
 * verified correctly. And the first message existed 106 ms BEFORE its own send
 * call returned, so a read sequenced behind the write would have seen it.
 *
 * ## The rule
 *
 * A read waits for every write still in flight in its own dispatch. A write
 * never waits — so the graph is acyclic and this cannot deadlock, which is the
 * property that makes an unbounded wait safe.
 *
 * **The wait costs the turn nothing**, which is the argument for not narrowing
 * it to "the same resource" (knowledge we do not have, and would get wrong for
 * MCP). The AI SDK awaits every tool call in the step before the step can end,
 * so a read that waits for a 30-second shell write finishes no later than the
 * step already would. It trades parallelism we cannot use for an answer that is
 * correct.
 *
 * Bounding the wait is correspondingly unnecessary rather than merely omitted: a
 * write that hangs forever already hangs the step, so waiting on it adds no new
 * way to get stuck.
 *
 * ## Known limit, stated because it is the one way this quietly does nothing
 *
 * A write registers when its `execute` is invoked, so a read only sees it if the
 * write appears FIRST in the step's tool calls. The SDK invokes them
 * synchronously in order, so write-first is sufficient and read-first is not.
 * That is acceptable on evidence rather than on faith: all 91 observed overlaps
 * are write-then-read, which is what "verify what I just did" looks like. The
 * fix for read-first would be a macrotask yield on every read so siblings can
 * register — a cost on every tool call in the product for a shape never once
 * observed.
 */
import { getCurrentDispatchId } from '../framework/dispatch-context.js';
import { debugLog } from '../logger.js';

/**
 * Writes currently executing, keyed by dispatch.
 *
 * Per dispatch, never global: `withSlot` allows four concurrent dispatches and
 * each MCP delegation adds another, so a single shared set would make one
 * sub-agent's write block an unrelated sibling's read — serializing work that
 * never raced.
 *
 * A `Set` of promises rather than one chained promise, so a settled write stops
 * being waited on rather than pinning every later read behind the longest write
 * the dispatch ever ran.
 */
const inFlightWrites = new Map<string, Set<Promise<unknown>>>();

/**
 * Runs one tool call, ordering it against the dispatch's in-flight writes.
 *
 * `isWrite` comes from the caller rather than being derived here, because
 * `augment.ts` has already computed it through `shouldBlockInReadOnly` — the
 * function that consults `meta.isWriteAction` per call and falls back to the
 * declared `kind`. Deriving it a second time is how two answers to one question
 * drift apart.
 */
export async function runOrdered<T>(isWrite: boolean, run: () => Promise<T>): Promise<T> {
  const key = getCurrentDispatchId();
  // Outside a dispatch there is no model step, so there are no parallel sibling
  // calls to race — `runWithDispatchId` wraps every `runAgent` and the SDK
  // invokes `execute` inside it. MCP connect probes and REPL helpers land here.
  if (key === undefined) return run();

  if (!isWrite) {
    const pending = inFlightWrites.get(key);
    if (pending && pending.size > 0) {
      const waited = pending.size;
      const startedAt = Date.now();
      // `allSettled`, never `all`: a read must not inherit a write's rejection.
      // The write's own caller still sees the throw — this only observes it.
      await Promise.allSettled([...pending]);
      debugLog('tool:read-after-write', { waitedOn: waited, waitedMs: Date.now() - startedAt });
    }
    return run();
  }

  // Started BEFORE registering, so the promise exists to register. Registration
  // is synchronous from here to the caller's next await, which is what lets a
  // sibling read issued later in the same step observe it.
  const promise = run();
  let set = inFlightWrites.get(key);
  if (!set) {
    set = new Set();
    inFlightWrites.set(key, set);
  }
  set.add(promise);
  try {
    return await promise;
  } finally {
    set.delete(promise);
    // The map is keyed on a dispatch id that is never reused, so an empty set
    // left behind is a leak for the life of the process rather than a tidiness
    // question.
    if (set.size === 0) inFlightWrites.delete(key);
  }
}

/** Test seam: no production caller, and none should exist. */
export function __resetWriteBarrier(): void {
  inFlightWrites.clear();
}
