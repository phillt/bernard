import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { AppRegistry } from '../apps/registry.js';
import {
  dispatchAction,
  resolveFromManifest,
  type InvocationFailure,
  type ResolvedInvocation,
} from '../apps/dispatch.js';
import { SpecialistStore } from '../specialists.js';
import { classifyError } from '../error-taxonomy.js';
import { appendJsonl, rotateJsonlByCount } from '../jsonl.js';
import { SCRIPT_LOG_FILE } from '../paths.js';
import { debugLog } from '../logger.js';
import { withStdoutRedirectedToStderr } from './stdout-guard.js';

/**
 * `bernard script` — the programmatic entry point (#419).
 *
 * A caller supplies an app id, a named action and typed arguments, and gets
 * exactly one JSON object on stdout plus an exit code. Everything else — the
 * agent's own chatter, MCP connect notices, tool-profile lines — goes to
 * stderr, so `bernard script … | jq .result` works.
 */

/** Default wall clock when neither the manifest nor the caller sets one. */
const DEFAULT_SCRIPT_TIMEOUT_MS = 5 * 60_000;

/** How many invocation records to keep in the log. */
const SCRIPT_LOG_KEEP = 2000;

export const EXIT_OK = 0;
/** The work ran and failed. */
export const EXIT_RUN_FAILED = 1;
/** The request was malformed — nothing was dispatched. */
export const EXIT_BAD_REQUEST = 2;

export interface ScriptRunOptions {
  app: string;
  action: string;
  /** Raw JSON text from `--args`, or the contents of `--args-file`. */
  argsJson?: string;
  argsFile?: string;
  /** May only SHORTEN the action's own wall clock, never extend it. */
  timeoutMs?: number;
}

/** One JSON object, written to stdout, and nothing else ever is. */
type ScriptResult =
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
      error: { code: string; category?: string; message: string };
    };

function emit(result: ScriptResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** Diagnostics go to stderr so the stdout stream stays parseable. */
function diag(msg: string): void {
  process.stderr.write(`${msg}\n`);
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
 * Resolves the effective wall clock.
 *
 * `--timeout` may only lower it. A caller cannot buy itself more time than the
 * manifest grants, which is what keeps the budget a property of the app rather
 * than of whoever is calling it.
 */
export function effectiveTimeoutMs(
  actionTimeoutMs: number | undefined,
  flagTimeoutMs: number | undefined,
): number {
  const ceiling = actionTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  if (flagTimeoutMs === undefined || flagTimeoutMs <= 0) return ceiling;
  return Math.min(flagTimeoutMs, ceiling);
}

/** Reads `--args` / `--args-file` into a JSON value. `-` means stdin. */
function readRawArgs(
  opts: ScriptRunOptions,
): { ok: true; value: unknown } | { ok: false; message: string } {
  let text = opts.argsJson;
  if (opts.argsFile !== undefined) {
    if (opts.argsJson !== undefined) {
      return { ok: false, message: 'Pass either --args or --args-file, not both.' };
    }
    try {
      // `-` reads stdin, which keeps long values out of `ps` and off ARG_MAX.
      text = fs.readFileSync(opts.argsFile === '-' ? 0 : opts.argsFile, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        message: `Could not read --args-file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (text === undefined || text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return {
      ok: false,
      message: `--args is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Prints the app's actions and their argument schemas, without dispatching. */
export function scriptDescribe(appId?: string): number {
  const registry = new AppRegistry();
  if (!appId) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, apps: registry.listIds() })}\n`);
    return EXIT_OK;
  }
  const app = registry.get(appId);
  if (!app.ok) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, ok: false, error: { code: app.failure.kind, message: app.failure.message } })}\n`,
    );
    return EXIT_BAD_REQUEST;
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, app: app.manifest })}\n`);
  return EXIT_OK;
}

/**
 * Runs one action. Returns the process exit code; the caller sets it.
 *
 * Never throws: an external caller gets a JSON object and an exit code for
 * every outcome, including the ones that are this command's own fault.
 */
export async function scriptRun(opts: ScriptRunOptions): Promise<number> {
  const invocationId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const fail = (code: string, message: string, category?: string): number => {
    emit({
      schemaVersion: 1,
      ok: false,
      invocationId,
      app: opts.app,
      action: opts.action,
      durationMs: Date.now() - startMs,
      error: { code, category, message },
    });
    recordInvocation({
      invocationId,
      appId: opts.app,
      action: opts.action,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      ok: false,
      errorCode: code,
      errorCategory: category,
      // Reserved for #420: the capability handle this invocation was minted
      // from. Always null here, so correlating mint with invoke is a value
      // fill rather than a schema migration (#420 R9).
      capabilityId: null,
    });
    return code === 'run_failed' || code === 'timeout' ? EXIT_RUN_FAILED : EXIT_BAD_REQUEST;
  };

  const raw = readRawArgs(opts);
  if (!raw.ok) return fail('invalid_args', raw.message);

  const registry = new AppRegistry();
  const resolved = resolveFromManifest(registry, opts.app, opts.action, raw.value);
  if (!resolved.ok) return fail(failureCode(resolved.failure), resolved.failure.message);

  const { invocation } = resolved;

  // Pre-flight: an action naming a specialist that does not exist is a broken
  // manifest, not a failed run — the caller should see exit 2, and no model
  // call should be billed for it.
  const specialist = new SpecialistStore().get(invocation.action.specialistId);
  if (!specialist) {
    return fail(
      'unknown_specialist',
      `Action "${opts.action}" names specialist "${invocation.action.specialistId}", which does not exist.`,
    );
  }

  const timeoutMs = effectiveTimeoutMs(invocation.action.timeoutMs, opts.timeoutMs);

  debugLog('script:invoke', {
    invocationId,
    appId: opts.app,
    action: opts.action,
    // Names only, never values: args carry the caller's data and the debug log
    // is not the place for it.
    argKeys: Object.keys(invocation.frozenArgs),
    specialistId: invocation.action.specialistId,
    toolMode: invocation.action.toolMode,
    timeoutMs,
  });

  const run = await withStdoutRedirectedToStderr(() =>
    dispatchAction({ invocation, timeoutMs, log: diag }),
  );

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  if (!run.ok) {
    const message = run.timedOut ? `Action timed out after ${run.timeoutMs} ms` : run.error;
    // Classified here, at the site that knows what the message means — the
    // same rule cron follows. `runHeadless` deliberately does not classify.
    const cls = classifyError({ message });
    emit({
      schemaVersion: 1,
      ok: false,
      invocationId,
      app: opts.app,
      action: opts.action,
      durationMs,
      error: { code: run.timedOut ? 'timeout' : 'run_failed', category: cls.category, message },
    });
    recordInvocation({
      invocationId,
      appId: opts.app,
      action: opts.action,
      argKeys: Object.keys(invocation.frozenArgs),
      specialistId: invocation.action.specialistId,
      toolsGranted: grantedToolNames(invocation),
      startedAt,
      completedAt,
      durationMs,
      ok: false,
      errorCode: run.timedOut ? 'timeout' : 'run_failed',
      errorCategory: cls.category,
      mcpConnectMs: run.timings.mcpConnectMs,
      capabilityId: null,
    });
    return EXIT_RUN_FAILED;
  }

  const wrapper = run.formatted;
  const ok = wrapper.status === 'ok';

  recordInvocation({
    invocationId,
    appId: opts.app,
    action: opts.action,
    argKeys: Object.keys(invocation.frozenArgs),
    specialistId: invocation.action.specialistId,
    toolsGranted: grantedToolNames(invocation),
    startedAt,
    completedAt,
    durationMs,
    ok,
    errorCode: ok ? undefined : 'run_failed',
    errorCategory: ok ? undefined : classifyError({ message: wrapper.error ?? '' }).category,
    mcpConnectMs: run.timings.mcpConnectMs,
    stepLimitHit: run.stepLimitHit,
    capabilityId: null,
  });

  if (!ok) {
    const message = wrapper.error ?? 'The action reported a failure with no message.';
    emit({
      schemaVersion: 1,
      ok: false,
      invocationId,
      app: opts.app,
      action: opts.action,
      durationMs,
      error: { code: 'run_failed', category: classifyError({ message }).category, message },
    });
    return EXIT_RUN_FAILED;
  }

  emit({
    schemaVersion: 1,
    ok: true,
    invocationId,
    app: opts.app,
    action: opts.action,
    startedAt,
    durationMs,
    result: wrapper.result,
    meta: {
      specialistId: invocation.action.specialistId,
      stepLimitHit: run.stepLimitHit,
      mcpConnectMs: run.timings.mcpConnectMs,
    },
  });
  return EXIT_OK;
}

/** The tools the action DECLARED. Recorded so a log reader can see the scope. */
function grantedToolNames(invocation: ResolvedInvocation): string[] {
  return invocation.action.toolAllowlist;
}

function failureCode(failure: InvocationFailure): string {
  return failure.kind;
}
