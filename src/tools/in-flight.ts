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
  /**
   * The dispatch that issued it, captured from the ALS at registration (#607).
   *
   * `augmentTools`' wrapper runs inside `runWithDispatchId`, which the AI SDK
   * preserves across `tool.execute` — measured, not assumed — so this is the
   * `runAgent` whose step is blocked on the call. A NESTED dispatch's own tools
   * register under the child's id instead, which is what makes the liveness
   * guard in `framework/runner.ts` recursive: a parent blocked on `subagent`
   * sees its own tool in flight and pauses, while the child's guard is the one
   * watching the child.
   *
   * `undefined` outside any dispatch — `apps/tool-dispatch.ts` runs a tool with
   * no model at all, and nothing there is waiting on a step boundary.
   */
  dispatchId: string | undefined;
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
  calls.set(id, { label, startedAt: Date.now(), dispatchId: getCurrentDispatchId() });
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
 * How many tool calls this dispatch is currently inside (#607).
 *
 * Read by the runner's liveness guard on the non-streaming branch, where there
 * is no per-part signal and a step boundary is the only proof of life — and a
 * step boundary fires only *after* the step's tools have returned, so without
 * this a dispatch legitimately waiting on `ask_user` or on a nested sub-agent
 * would be indistinguishable from a wedged one.
 *
 * Counted, never timestamped: `onStepFinish` fires immediately after the last
 * tool of a step resolves (measured), so the runner's own progress stamp lands
 * within microseconds of the count returning to zero and there is no window in
 * which the clock is both running and stale.
 *
 * A linear scan rather than a second map keyed by dispatch: the registry holds
 * one entry per call the process is currently inside, which the agent pool caps
 * near twenty, and a parallel index is a second thing to keep in step for a
 * saving nothing can measure.
 */
export function inFlightForDispatch(dispatchId: string): number {
  let n = 0;
  for (const call of calls.values()) if (call.dispatchId === dispatchId) n += 1;
  return n;
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

/** Test seam: no production caller, and none should exist. */
export function __resetInFlightCalls(): void {
  calls.clear();
}
