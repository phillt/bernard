import * as crypto from 'node:crypto';
import { invocationRefusal } from '../specialist-authority.js';
import { AppRegistry } from './registry.js';
import { grantedToolNames, resolveFromManifest } from './invocation.js';
import type { DispatchActionResult } from './dispatch.js';
import { SpecialistStore } from '../specialists.js';
import { classifyError } from '../error-taxonomy.js';
import { sendToSessions } from '../inbox/send.js';
import { appendJsonl, rotateJsonlByCount } from '../jsonl.js';
import { SCRIPT_LOG_FILE } from '../paths.js';
import { debugLog } from '../logger.js';

/**
 * Running one app action, with no opinion about who asked.
 *
 * Extracted from `src/script/run.ts` for #421, and the reason is correctness
 * rather than tidiness. `scriptRun` is welded to the process in four ways: it
 * returns an exit code instead of the result, its `fail()` both emits and
 * returns a code, its `log` writes to `process.stderr`, and — the
 * disqualifying one — it wraps the dispatch in
 * `withStdoutRedirectedToStderr`, which monkey-patches `process.stdout.write`
 * **process-globally**. That is right for a one-shot CLI and actively wrong
 * for a server: two overlapping HTTP invocations would nest and unwind the
 * patch against each other, and the host's own stdout would vanish meanwhile.
 *
 * So the shared middle lives here and touches no process state. `scriptRun`
 * is now a CLI adapter that emits and maps to an exit code; the applet host's
 * callback endpoint is a second adapter that shapes the same result as an
 * HTTP response.
 */

/** Default wall clock when neither the manifest nor the caller sets one. */
export const DEFAULT_INVOKE_TIMEOUT_MS = 5 * 60_000;

/** How many invocation records to keep in the log. */
const SCRIPT_LOG_KEEP = 2000;

/**
 * Everything an invocation itself can fail as.
 *
 * The CLI adds its own codes on top (a missing flag, a throw out of the
 * command); those are not invocation failures and do not belong here.
 */
export type InvocationErrorCode =
  | 'unknown_app'
  | 'unknown_action'
  | 'invalid_manifest'
  | 'invalid_args'
  | 'unknown_specialist'
  /**
   * The named specialist exists but is bound to a different applet action
   * (#423). Distinct from `unknown_specialist` — the record is there, and
   * saying it is missing would send an integrator looking for the wrong bug.
   */
  | 'specialist_not_bound'
  /** The named specialist exists but the user disabled it. */
  | 'specialist_unavailable'
  | 'run_failed'
  | 'timeout';

/**
 * The result shape, shared by every caller.
 *
 * This is the JSON `bernard script` writes and the JSON the applet host's
 * callback endpoint returns. `schemaVersion` exists to be bumped, which only
 * works while one module owns the shape — it was previously hand-rolled at
 * five sites across two modules and had already drifted.
 */
export type InvocationResult =
  | {
      schemaVersion: 1;
      ok: true;
      invocationId: string;
      app: string;
      action: string;
      startedAt: string;
      durationMs: number;
      result: unknown;
      meta: {
        /** Which tier ran this action (#445): an agent, or one direct tool call. */
        dispatch: 'agent' | 'tool';
        /** Present on the agent arm. */
        specialistId?: string;
        /** Present on the tool arm. */
        tool?: string;
        stepLimitHit: boolean;
        /** Always 0 on the tool arm — it never connects to MCP at all. */
        mcpConnectMs: number;
      };
    }
  | {
      schemaVersion: 1;
      ok: false;
      invocationId: string;
      app: string;
      action: string;
      durationMs: number;
      error: { code: InvocationErrorCode; category?: string; message: string };
    };

export interface InvokeActionOptions {
  appId: string;
  action: string;
  /**
   * Already-parsed arguments. The CLI's `--args` / `--args-file` reading stays
   * in `run.ts`; an HTTP caller has a JSON body, not a file path.
   */
  args: unknown;
  /** May only SHORTEN the action's own wall clock, never extend it. */
  timeoutMs?: number;
  /**
   * Progress sink. Defaults to a no-op, and must never be `process.stdout` —
   * see the module note. The CLI passes a stderr writer.
   */
  log?: (msg: string) => void;
  /**
   * The capability handle this invocation was minted from (#420). `null` for a
   * direct CLI call, which is why the log's `capabilityId` column exists
   * already: filling it is a value change rather than a schema migration (R9).
   */
  capabilityId?: string | null;
  abortSignal?: AbortSignal;
}

/**
 * Resolves the effective wall clock.
 *
 * `--timeout` may only lower it. A caller cannot buy itself more time than the
 * manifest grants, which keeps the budget a property of the app rather than of
 * whoever is calling it.
 *
 * Non-finite input falls back to the ceiling rather than propagating.
 * `Number.isFinite` rather than `<= 0` alone, because `NaN` passes every
 * ordering comparison: `NaN <= 0` is false, so a `NaN` reached `Math.min` and
 * came back out, then `setTimeout(cb, NaN)` — which Node coerces to `0` —
 * fired the abort immediately and reported "timed out after NaN ms".
 */
export function effectiveTimeoutMs(
  actionTimeoutMs: number | undefined,
  flagTimeoutMs: number | undefined,
): number {
  const ceiling =
    actionTimeoutMs !== undefined && Number.isFinite(actionTimeoutMs)
      ? actionTimeoutMs
      : DEFAULT_INVOKE_TIMEOUT_MS;
  if (flagTimeoutMs === undefined || !Number.isFinite(flagTimeoutMs) || flagTimeoutMs <= 0) {
    return ceiling;
  }
  return Math.min(flagTimeoutMs, ceiling);
}

function recordInvocation(entry: InvocationLogRow): void {
  try {
    appendJsonl(SCRIPT_LOG_FILE, entry);
    rotateJsonlByCount(SCRIPT_LOG_FILE, SCRIPT_LOG_KEEP);
  } catch {
    // The log must never take down an invocation.
  }
}

/**
 * How much of an error message is kept.
 *
 * Bounded because the row budget is a COUNT, not a size: without a cap one
 * agent's stack trace could dwarf the 2,000 rows around it. The same 500-char
 * idiom `cron-logs.ts` uses for a persisted tool result.
 */
const MESSAGE_MAX = 500;

/**
 * What may be written into the log for a failure, and what may not (#461).
 *
 * The message is the whole point of the record — it is Bernard's own words, or
 * a tool's, and dropping it is what made a real failure read back as
 * `run_failed`/`unknown`. But **`invalid_args` is different in kind**: that
 * message is rendered by `formatZodError` over the CALLER's arguments, and zod
 * echoes the value it rejected —
 *
 *     mode: Invalid enum value. Expected 'quick' | 'thorough', received 'hunter2'
 *
 * — so storing it verbatim would put caller data in the log on precisely the
 * path where the caller supplied it, breaking the keys-never-values rule this
 * file otherwise keeps by construction (`argKeys`, and the sibling comments in
 * `capability-log.ts` and `tool-dispatch.ts`).
 *
 * So: keep the message for every other code, and for `invalid_args` keep only
 * the field PATHS, which are argument names and therefore already permitted.
 * A validation failure is still diagnosable — "which field" is the question
 * being asked — without the value that failed.
 */
export function loggableMessage(code: InvocationErrorCode, message: string): string {
  if (code !== 'invalid_args') return message.slice(0, MESSAGE_MAX);
  // `formatZodError` emits `path: reason; path: reason`. The path is
  // everything before the first colon of each clause.
  const paths = message
    .split(';')
    .map((clause) => clause.trim().split(':')[0]?.trim())
    .filter((path): path is string => Boolean(path) && !path.includes(' '));
  return paths.length > 0
    ? `invalid arguments at: ${paths.join(', ')} (values withheld)`
    : 'invalid arguments (values withheld)';
}

/**
 * One row of `script-invocations.jsonl`.
 *
 * Typed because it was `Record<string, unknown>`, so no field was checked by
 * the compiler and a reader had to guess. Argument VALUES never appear here —
 * only `argKeys`; see {@link loggableMessage} for the one message that has to
 * be reduced to keep that true.
 */
export interface InvocationLogRow {
  invocationId: string;
  appId: string;
  action: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ok: boolean;
  capabilityId: string | null;
  errorCode?: InvocationErrorCode;
  errorCategory?: string;
  /** The failure's own words, reduced for `invalid_args`. */
  errorMessage?: string;
  argKeys?: string[];
  specialistId?: string;
  tool?: string;
  /** What the action DECLARED it wanted. */
  toolAllowlist?: string[];
  /** What it actually got — the intersection with the specialist's targets. */
  toolsGranted?: string[];
  mcpConnectMs?: number;
  stepLimitHit?: boolean;
}

/**
 * Tells any running REPL that an applet action failed (#461 → #462).
 *
 * Hooked into `fail()` rather than at each call site because that function is
 * already "the single failure path… written once because the three hand-rolled
 * copies it replaced had diverged" — so this covers every failure shape there
 * is, and every one added later, by construction.
 *
 * It crosses processes even though it is an in-process call: the applet host
 * daemon is not the REPL. Shelling out to `bernard say` would cost a Node cold
 * start inside an HTTP request handler and would require `dist/` to exist.
 *
 * `{ all: true }` because refusing on ambiguity would drop the notice in the
 * two-terminal case where it is most useful, and the sender's dedupe window
 * covers a page that retries a broken button.
 *
 * Guarded: a notification must never turn a handled failure into an unhandled
 * one.
 */
function notifySessions(appId: string, action: string, message: string): void {
  try {
    sendToSessions({
      text: `Applet "${appId}" action "${action}" failed: ${message}`,
      source: { kind: 'applet', label: `applet:${appId}` },
      hint: `bernard app logs ${appId} --last 5`,
      target: { all: true },
    });
  } catch {
    // Nothing about reporting a failure may create one.
  }
}

/**
 * Runs one app action and returns its result. Never throws, never writes to
 * stdout, never touches `process`.
 */
export async function invokeAction(opts: InvokeActionOptions): Promise<InvocationResult> {
  const invocationId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const log = opts.log ?? (() => {});
  const capabilityId = opts.capabilityId ?? null;

  /**
   * The single failure path. Every branch returns the same envelope and writes
   * the same record, differing only in the extra fields a post-dispatch
   * failure can supply.
   *
   * Written once because the three hand-rolled copies it replaced had already
   * diverged: one classified the wrapper error twice, against two different
   * strings, so the category in the log could disagree with the category
   * handed to the caller for the same failure.
   */
  const fail = (
    code: InvocationErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ): InvocationResult => {
    const durationMs = Date.now() - startMs;
    // Only a failure that actually RAN gets a taxonomy category. Classifying
    // "No such app: nope" yields `unknown`, which is noise dressed as a
    // diagnosis — the request-shaped failures already say precisely what was
    // wrong in `code`.
    const category =
      code === 'run_failed' || code === 'timeout' ? classifyError({ message }).category : undefined;
    recordInvocation({
      invocationId,
      appId: opts.appId,
      action: opts.action,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs,
      ok: false,
      errorCode: code,
      errorCategory: category,
      errorMessage: loggableMessage(code, message),
      ...extra,
      capabilityId,
    });
    notifySessions(opts.appId, opts.action, message);
    return {
      schemaVersion: 1,
      ok: false,
      invocationId,
      app: opts.appId,
      action: opts.action,
      durationMs,
      error: { code, category, message },
    };
  };

  /**
   * The single success path, the sibling of {@link fail}.
   *
   * The two arms had hand-rolled this envelope and its log row, and had
   * already diverged — one recomputed `durationMs` independently and omitted
   * `mcpConnectMs`/`stepLimitHit` from the row while hard-coding them in the
   * envelope. That is exactly what `fail` exists to prevent, applied to the
   * other half of the same table.
   */
  const succeed = (
    appId: string,
    action: string,
    result: unknown,
    meta: Extract<InvocationResult, { ok: true }>['meta'],
    extra: Record<string, unknown>,
  ): InvocationResult => {
    const durationMs = Date.now() - startMs;
    recordInvocation({
      invocationId,
      appId,
      action,
      ...extra,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs,
      ok: true,
      mcpConnectMs: meta.mcpConnectMs,
      stepLimitHit: meta.stepLimitHit,
      capabilityId,
    });
    return {
      schemaVersion: 1,
      ok: true,
      invocationId,
      app: appId,
      action,
      startedAt,
      durationMs,
      result,
      meta,
    };
  };

  const registry = new AppRegistry();
  const resolved = resolveFromManifest(registry, opts.appId, opts.action, opts.args);
  if (!resolved.ok) return fail(resolved.failure.kind, resolved.failure.message);

  const { invocation } = resolved;
  const argKeys = Object.keys(invocation.frozenArgs);
  const timeoutMs = effectiveTimeoutMs(invocation.action.timeoutMs, opts.timeoutMs);
  const dispatch = invocation.action.dispatch;

  /** Everything both arms log, plus the one field that names which arm ran. */
  const logInvoke = (arm: Record<string, string>): void =>
    debugLog('script:invoke', {
      invocationId,
      appId: invocation.appId,
      action: invocation.actionName,
      // Names only, never values: args carry the caller's data and the debug
      // log is not the place for it.
      argKeys,
      ...arm,
      toolMode: invocation.action.toolMode,
      timeoutMs,
      capabilityId,
    });

  // The deterministic tier (#445). Branches before anything agent-shaped is
  // touched — no specialist lookup, no MCP connect, no RAG store, no model —
  // because the whole value of this arm is that it costs nothing.
  if (dispatch.kind === 'tool') {
    logInvoke({ tool: dispatch.tool });
    const { dispatchToolAction } = await import('./tool-dispatch.js');
    const run = await dispatchToolAction({
      invocation,
      dispatch,
      timeoutMs,
      abortSignal: opts.abortSignal,
    });
    const toolDispatched = { argKeys, tool: dispatch.tool, toolsGranted: [dispatch.tool] };
    if (!run.ok) {
      // `invalid` is a broken manifest — an ineligible tool, or a mapping the
      // tool's own schema rejects — and must read as a request failure (exit
      // 2) rather than a run that might succeed on retry.
      return run.kind === 'invalid'
        ? fail('invalid_manifest', run.message, toolDispatched)
        : fail(run.timedOut ? 'timeout' : 'run_failed', run.message, toolDispatched);
    }
    return succeed(
      invocation.appId,
      invocation.actionName,
      run.result,
      { dispatch: 'tool', tool: dispatch.tool, stepLimitHit: false, mcpConnectMs: 0 },
      toolDispatched,
    );
  }

  // Pre-flight: an action naming a specialist that does not exist is a broken
  // manifest, not a failed run — the caller should see a request-shaped
  // failure, and no model call should be billed for it.
  const specialist = new SpecialistStore().get(dispatch.specialistId);
  // The INVERTED case: permits the specialist bound to exactly this
  // (appId, action) and refuses everyone else. Shared with the two tool
  // dispatches so the inversion is expressed once as data — an inverted
  // duplicate of a rule is precisely where two copies drift apart.
  //
  // It also brings `disabled` to this path for the first time: an applet
  // action dispatches through `runHeadless`, not `dispatchToolWrapper`, so a
  // specialist the user disabled in `/specialists` was still running behind
  // every applet button.
  const refusal = specialist
    ? invocationRefusal(specialist, {
        kind: 'app',
        appId: invocation.appId,
        action: invocation.actionName,
      })
    : null;
  if (refusal) {
    return fail(
      refusal.code === 'disabled' ? 'specialist_unavailable' : 'specialist_not_bound',
      refusal.message,
    );
  }
  if (!specialist) {
    return fail(
      'unknown_specialist',
      `Action "${opts.action}" names specialist "${dispatch.specialistId}", which does not exist.`,
    );
  }

  // What the action actually gets, not what it declared. Through the same
  // function `buildActionTools` uses, because a log that overstates the grant
  // is worse than no log — and this is the audit trail.
  const toolsGranted = grantedToolNames(invocation.action, specialist.targetTools);

  logInvoke({ specialistId: dispatch.specialistId });

  // The same id `runHeadless` namespaces its debug lines with, so
  // `script:mcp:ready` joins the invocation record rather than naming a run
  // that appears nowhere else.
  // Deferred for the same reason the tool arm above is (#452): `dispatch.ts`
  // statically imports `createTools`, so importing it at module load made
  // `bernard script` pay for the whole agent runtime BEFORE reaching the
  // `kind === 'tool'` branch that exists to avoid exactly that. Measured 168 ms
  // on `apps/invoke.js` against 76 for the worker path.
  const { dispatchAction } = await import('./dispatch.js');
  const run: DispatchActionResult = await dispatchAction({
    invocation,
    specialist,
    timeoutMs,
    log,
    runId: invocationId,
    abortSignal: opts.abortSignal,
  });

  // Both halves of the intersection, deliberately (#461). `toolsGranted` alone
  // is the load-bearing signal — the observed failure declared
  // `toolAllowlist: ['datetime']` and got an EMPTY grant because the backing
  // specialist targeted none of it, then answered "No datetime tool
  // available". Logging only the declared list would have read as fine; only
  // the pair makes the gap computable at read time.
  const dispatched = {
    argKeys,
    specialistId: dispatch.specialistId,
    toolAllowlist: invocation.action.toolAllowlist,
    toolsGranted,
  };

  if (!run.ok) {
    return fail(
      run.timedOut ? 'timeout' : 'run_failed',
      run.timedOut ? `Action timed out after ${run.timeoutMs} ms` : run.error,
      { ...dispatched, mcpConnectMs: run.timings.mcpConnectMs },
    );
  }

  const wrapper = run.formatted;
  if (wrapper.status !== 'ok') {
    return fail('run_failed', wrapper.error ?? 'The action reported a failure with no message.', {
      ...dispatched,
      mcpConnectMs: run.timings.mcpConnectMs,
      stepLimitHit: run.stepLimitHit,
    });
  }

  return succeed(
    invocation.appId,
    invocation.actionName,
    wrapper.result,
    {
      dispatch: 'agent',
      specialistId: dispatch.specialistId,
      stepLimitHit: run.stepLimitHit,
      mcpConnectMs: run.timings.mcpConnectMs,
    },
    dispatched,
  );
}
