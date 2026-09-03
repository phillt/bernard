import * as crypto from 'node:crypto';
import { AppRegistry } from './registry.js';
import { resolveFromManifest } from './invocation.js';
import { dispatchAction } from './dispatch.js';
import { SpecialistStore } from '../specialists.js';
import { classifyError } from '../error-taxonomy.js';
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
      meta: { specialistId: string; stepLimitHit: boolean; mcpConnectMs: number };
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

function recordInvocation(entry: Record<string, unknown>): void {
  try {
    appendJsonl(SCRIPT_LOG_FILE, entry);
    rotateJsonlByCount(SCRIPT_LOG_FILE, SCRIPT_LOG_KEEP);
  } catch {
    // The log must never take down an invocation.
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
      ...extra,
      capabilityId,
    });
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

  const registry = new AppRegistry();
  const resolved = resolveFromManifest(registry, opts.appId, opts.action, opts.args);
  if (!resolved.ok) return fail(resolved.failure.kind, resolved.failure.message);

  const { invocation } = resolved;
  // The action DECLARED these; recorded so a log reader can see the scope.
  const toolsGranted = invocation.action.toolAllowlist;
  const argKeys = Object.keys(invocation.frozenArgs);

  // Pre-flight: an action naming a specialist that does not exist is a broken
  // manifest, not a failed run — the caller should see a request-shaped
  // failure, and no model call should be billed for it. `exists` rather than
  // `get`, which reads and parses the record only for its truthiness;
  // `runHeadless` reads it properly a moment later.
  if (!new SpecialistStore().exists(invocation.action.specialistId)) {
    return fail(
      'unknown_specialist',
      `Action "${opts.action}" names specialist "${invocation.action.specialistId}", which does not exist.`,
    );
  }

  const timeoutMs = effectiveTimeoutMs(invocation.action.timeoutMs, opts.timeoutMs);

  debugLog('script:invoke', {
    invocationId,
    appId: invocation.appId,
    action: invocation.actionName,
    // Names only, never values: args carry the caller's data and the debug log
    // is not the place for it.
    argKeys,
    specialistId: invocation.action.specialistId,
    toolMode: invocation.action.toolMode,
    timeoutMs,
    capabilityId,
  });

  // The same id `runHeadless` namespaces its debug lines with, so
  // `script:mcp:ready` joins the invocation record rather than naming a run
  // that appears nowhere else.
  const run = await dispatchAction({
    invocation,
    timeoutMs,
    log,
    runId: invocationId,
    abortSignal: opts.abortSignal,
  });

  const dispatched = { argKeys, specialistId: invocation.action.specialistId, toolsGranted };

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

  const durationMs = Date.now() - startMs;
  recordInvocation({
    invocationId,
    appId: invocation.appId,
    action: invocation.actionName,
    ...dispatched,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs,
    ok: true,
    mcpConnectMs: run.timings.mcpConnectMs,
    stepLimitHit: run.stepLimitHit,
    capabilityId,
  });

  return {
    schemaVersion: 1,
    ok: true,
    invocationId,
    app: invocation.appId,
    action: invocation.actionName,
    startedAt,
    durationMs,
    result: wrapper.result,
    meta: {
      specialistId: invocation.action.specialistId,
      stepLimitHit: run.stepLimitHit,
      mcpConnectMs: run.timings.mcpConnectMs,
    },
  };
}
