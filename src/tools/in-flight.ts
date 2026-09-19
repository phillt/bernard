/**
 * @module tools/in-flight
 *
 * Which tool call is currently keeping the user waiting, and for how long
 * (#594).
 *
 * ## The defect
 *
 * A `send_message` against a dead MCP proxy held one turn for 35 minutes. On
 * screen for all 35 of them: `⠹ thinking…`. The information needed to say
 * *"beeper.send_message has been running for 4 minutes"* existed — the runner's
 * watchdog computed `inFlightTools` every 30 seconds and logged it — but it went
 * to `debugLog`, which is a no-op unless somebody had already suspected a
 * problem and restarted with `BERNARD_DEBUG=1`. A diagnostic only available to
 * someone who already knows is not a diagnostic.
 *
 * ## Why here and not in the runner
 *
 * The runner's `progress.onPart` sees a part TYPE and nothing else — it can
 * count tool calls, it cannot name one. `augment.ts` brackets every tool call in
 * the product and has the name, the metadata and the clock. It also covers the
 * non-streaming dispatches the runner's watchdog structurally cannot: a cron
 * run, a sub-agent, a delegate helper. The incident had three nested dispatches
 * and the innermost was the one actually stuck.
 *
 * Module-level rather than threaded, following `providers/request-counter.ts`:
 * `augmentTools` is a free function with nothing to hang state on, and every
 * alternative makes a diagnostic into an opt-in every caller must remember.
 *
 * Global rather than per-dispatch, unlike `write-barrier.ts` beside it. That
 * module orders calls, so mixing dispatches would serialize unrelated work;
 * this one answers "what is the user waiting on", and the user is waiting on all
 * of them at once.
 */
import { getCurrentDispatchId } from '../framework/dispatch-context.js';
import type { ToolMeta } from '../framework/tools/types.js';

/** A call the product is currently inside. */
interface InFlightCall {
  label: string;
  startedAt: number;
}

/**
 * Keyed by an id we mint, never by tool name: the same tool can be in flight
 * twice (the SDK runs a step's calls in parallel, and four dispatches run
 * concurrently), and a name-keyed map would have the second registration evict
 * the first and the first completion clear both.
 */
const calls = new Map<number, InFlightCall>();
let nextId = 1;

/** A call has started. The returned id must be handed back to {@link endToolCall}. */
export function beginToolCall(label: string): number {
  const id = nextId++;
  calls.set(id, { label, startedAt: Date.now() });
  return id;
}

/** A call has finished, failed, or been abandoned. Safe to call twice. */
export function endToolCall(id: number): void {
  calls.delete(id);
}

/**
 * Runs one tool call, registered for the duration.
 *
 * Composes with `runOrdered` the way `withSlot` composes with
 * `runDispatchOrFail`, and it goes on the INSIDE: a read parked behind
 * `write-barrier`'s wait has not started yet, and registering it there would
 * make it beat the write it is waiting on to the "most recently started" slot —
 * naming the blocked call instead of the blocking one.
 */
export async function runTracked<T>(label: string, run: () => Promise<T>): Promise<T> {
  const id = beginToolCall(label);
  try {
    return await run();
  } finally {
    endToolCall(id);
  }
}

/**
 * How many augmented tool wrappers this dispatch is currently inside (#607).
 *
 * ## Why this is a SECOND registry rather than a field on the one above
 *
 * The two answer different questions and want different brackets, and the first
 * cut of #607 tried to serve both from one entry and shipped a live-work-killing
 * bug. `pendingCallNotice` wants a NARROW bracket — from the moment a call is
 * really executing — which is why `runTracked` sits inside `runOrdered`: a read
 * parked on the write barrier has not started, and registering it there would
 * make it out-rank the write it is waiting on. The runner's liveness guard wants
 * the WIDEST possible bracket: anything that can hold a `generateText` step open
 * without completing it. Those are not the same span, and the gap between them
 * is where a person lives.
 *
 * Measured, against the commit that had only the narrow one: with a high-risk
 * tool and a `confirmAction` that never resolves, the dispatch has no finished
 * step AND a zero count, and the guard kills it — `Dispatch timed out — no step
 * completed for 150 ms with no tool running`, `confirmAction` still pending,
 * `execute` never entered. `runBlockGate` and `runGate` both await a human
 * OUTSIDE `runTracked` (`augment.ts`, both the envelope and the legacy/MCP
 * branches). The streaming branch does not have this window, because
 * `inFlightTools` counts the `tool-call` PART, which the SDK emits before
 * `execute` is entered — so the part-counted signal already brackets the gates
 * and the registry-counted one did not.
 *
 * ## Why a depth counter rather than a wider call list
 *
 * Widening the call list would have made one number mean two things — a call
 * parked on a confirm prompt would start being NAMED by the spinner, and a read
 * parked on the write barrier would out-rank the write. A counter keyed on the
 * dispatch is the whole of what the guard reads (`=== 0`), so it can have the
 * bracket it needs without touching what the notice sees.
 *
 * ## Why keyed on the dispatch
 *
 * `enterToolWrapper` reads the ALS, which `runWithDispatchId` preserves across
 * `tool.execute` — measured, not assumed. A NESTED dispatch's own tools count
 * under the child's id, which is what makes the liveness guard recursive: a
 * parent blocked on `subagent` sees its own wrapper open and pauses, while the
 * child's guard is the one watching the child. Counted globally, one busy
 * dispatch would silence every other dispatch's guard for as long as it ran.
 *
 * `undefined` outside any dispatch — `apps/tool-dispatch.ts` runs a tool with no
 * model at all, and nothing there is waiting on a step boundary.
 */
const wrapperDepth = new Map<string, number>();

/** A dispatch has entered a tool wrapper — gates, barrier, execute and all. */
export function enterToolWrapper(): string | undefined {
  const id = getCurrentDispatchId();
  if (id !== undefined) wrapperDepth.set(id, (wrapperDepth.get(id) ?? 0) + 1);
  return id;
}

/**
 * The wrapper has returned, however it returned.
 *
 * The key is DELETED at zero rather than left holding a `0`: a dispatch id is
 * never reused, so a key per dispatch that ever ran a tool is an unbounded map
 * in a process that stays up for days.
 */
export function exitToolWrapper(id: string | undefined): void {
  if (id === undefined) return;
  const n = (wrapperDepth.get(id) ?? 0) - 1;
  if (n > 0) wrapperDepth.set(id, n);
  else wrapperDepth.delete(id);
}

export function inFlightForDispatch(dispatchId: string): number {
  return wrapperDepth.get(dispatchId) ?? 0;
}

/**
 * The call worth naming right now, or `null` when nothing has been running long
 * enough to be worth interrupting the spinner for.
 *
 * **The most recently started one over the threshold, not the longest running.**
 * In the incident the three candidates were `delegate_beeper` → `specialist_run`
 * → `beeper.send_message`, nested, so the longest-running is the outermost — and
 * naming a frame that is merely *waiting* on another frame says less than naming
 * the one that is actually blocked. Last-started is the innermost.
 *
 * `nowMs` is a parameter so this is a pure function of the registry and the
 * clock, which is what makes the threshold testable without waiting for it.
 */
export function pendingCallNotice(
  nowMs: number,
  minMs: number,
): { label: string; ms: number } | null {
  let best: { label: string; ms: number; startedAt: number } | null = null;
  for (const call of calls.values()) {
    const ms = nowMs - call.startedAt;
    if (ms < minMs) continue;
    if (best === null || call.startedAt > best.startedAt) {
      best = { label: call.label, ms, startedAt: call.startedAt };
    }
  }
  return best === null ? null : { label: best.label, ms: best.ms };
}

/**
 * How long a call runs before it is named.
 *
 * 10 s rather than the ~15 the issue suggests: most tool calls finish inside 5,
 * so the ones this catches are already anomalous, and naming a `web_read` that
 * took 12 seconds is informative rather than noisy. The cost of being early is a
 * true statement the user did not need; the cost of being late is the 35 minutes
 * of silence this exists to end.
 */
export const LONG_CALL_NOTICE_MS = 10_000;

/**
 * What to call this tool when telling a person what Bernard is waiting on.
 *
 * An MCP tool's registry key is namespaced and, at the truncation ladder's last
 * rung, not invertible — so it is rebuilt from the metadata the manager already
 * authored (`category` is `mcp.<server>`, `rawName` is the server's own name for
 * the tool) rather than re-parsed out of the key. Everything else is its own
 * name, which is already what the user sees.
 */
export function displayToolName(toolName: string, meta?: ToolMeta): string {
  const server = meta?.category?.startsWith('mcp.') ? meta.category.slice(4) : undefined;
  if (server && meta?.rawName) return `${server}.${meta.rawName}`;
  return toolName;
}

/** Test seam for the retention rule: no production caller, and none should exist. */
export function __wrapperDepthSize(): number {
  return wrapperDepth.size;
}

/** Test seam: no production caller, and none should exist. */
export function __resetInFlightCalls(): void {
  calls.clear();
  wrapperDepth.clear();
}
