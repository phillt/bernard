import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { AppRegistry } from '../apps/registry.js';
import { resolveFromManifest, type ResolvedInvocation } from '../apps/invocation.js';
import { dispatchAction } from '../apps/dispatch.js';
import type { ParseResult } from '../apps/manifest.js';
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

/**
 * Every way an invocation can fail, and the exit code each maps to.
 *
 * A table rather than a comparison, so adding a code is a compile error until
 * its exit status is decided. The predecessor tested
 * `code === 'run_failed' || code === 'timeout'` inside the pre-dispatch
 * helper — where neither value can occur — so the arm that looked like the
 * classification rule was dead, and a new failure kind would have silently
 * inherited exit 2. #420 explicitly plans more producers of these kinds.
 *
 * The 1/2 split is the contract: `1` means the work failed and a retry might
 * help; `2` means the request was wrong and retrying it cannot.
 */
const EXIT_FOR = {
  unknown_app: EXIT_BAD_REQUEST,
  unknown_action: EXIT_BAD_REQUEST,
  invalid_manifest: EXIT_BAD_REQUEST,
  invalid_args: EXIT_BAD_REQUEST,
  unknown_specialist: EXIT_BAD_REQUEST,
  invalid_request: EXIT_BAD_REQUEST,
  internal_error: EXIT_BAD_REQUEST,
  run_failed: EXIT_RUN_FAILED,
  timeout: EXIT_RUN_FAILED,
} as const;

export type ScriptErrorCode = keyof typeof EXIT_FOR;

export interface ScriptRunOptions {
  app: string;
  action: string;
  /** Raw JSON text from `--args`, or the contents of `--args-file`. */
  argsJson?: string;
  argsFile?: string;
  /** May only SHORTEN the action's own wall clock, never extend it. */
  timeoutMs?: number;
}

/** The CLI's whole option surface, so `src/index.ts` stays a declaration shim. */
export interface ScriptCliOptions {
  app?: string;
  action?: string;
  args?: string;
  argsFile?: string;
  timeout?: number;
  describe?: boolean;
}

/**
 * The one JSON object written to stdout, and nothing else ever is.
 *
 * Every producer goes through {@link emit} / {@link emitError}. They used to be
 * hand-rolled at five sites across two modules, and had already drifted: the
 * two in `src/index.ts` omitted `invocationId` and `durationMs`, so a caller
 * reading either field off a failure got `undefined` for exactly the two
 * failures it did not cause. `schemaVersion` exists to be bumped, which only
 * works while one module owns the shape.
 */
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
      error: { code: ScriptErrorCode; category?: string; message: string };
    };

function emit(result: ScriptResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** Diagnostics go to stderr so the stdout stream stays parseable. */
function diag(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/**
 * Emits a failure envelope for a request that never reached an invocation —
 * a missing flag, or a throw out of the command itself.
 */
export function emitError(code: ScriptErrorCode, message: string): number {
  emit({
    schemaVersion: 1,
    ok: false,
    invocationId: crypto.randomUUID(),
    app: '',
    action: '',
    durationMs: 0,
    error: { code, message },
  });
  return EXIT_FOR[code];
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
function readRawArgs(opts: ScriptRunOptions): ParseResult<unknown> {
  let text = opts.argsJson;
  if (opts.argsFile !== undefined) {
    if (opts.argsJson !== undefined) {
      return { ok: false, error: 'Pass either --args or --args-file, not both.' };
    }
    try {
      // `-` reads stdin, which keeps long values out of `ps` and off ARG_MAX.
      text = fs.readFileSync(opts.argsFile === '-' ? 0 : opts.argsFile, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        error: `Could not read --args-file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (text === undefined || text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return {
      ok: false,
      error: `--args is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
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
  if (!app.ok) return emitError(app.failure.kind, app.failure.message);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, app: app.manifest })}\n`);
  return EXIT_OK;
}

/**
 * The whole `bernard script` command: flag validation, describe-vs-run, and
 * the catch-all. `src/index.ts` declares the options and sets the exit code.
 *
 * Lives here rather than inlined in the CLI because this module owns the
 * stdout contract, and the neighbouring subcommands in `index.ts` are all
 * thin shims over a module.
 */
export async function scriptMain(options: ScriptCliOptions): Promise<number> {
  try {
    if (options.describe) {
      // `--describe` with no `--app` lists the registered apps; with one, it
      // prints that app's action schemas. This is what an applet host reads to
      // build its buttons, and it is what makes the closed registry
      // inspectable rather than something a caller has to guess at.
      return scriptDescribe(options.app);
    }
    if (!options.app || !options.action) {
      return emitError(
        'invalid_request',
        '--app and --action are required unless --describe is given.',
      );
    }
    return await scriptRun({
      app: options.app,
      action: options.action,
      argsJson: options.args,
      argsFile: options.argsFile,
      timeoutMs: options.timeout,
    });
  } catch (err: unknown) {
    // `scriptRun` answers every outcome with JSON, so reaching here means the
    // command itself broke. Keep stdout parseable even then.
    return emitError('internal_error', err instanceof Error ? err.message : String(err));
  }
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

  /**
   * The single failure path. Every branch emits the same envelope and writes
   * the same record, differing only in the extra fields a post-dispatch
   * failure can supply.
   *
   * Written once because the three hand-rolled copies it replaces had already
   * diverged: one classified the wrapper error twice, against two different
   * strings, so the category in the log could disagree with the category
   * handed to the caller for the same failure.
   */
  const fail = (
    code: ScriptErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ): number => {
    const durationMs = Date.now() - startMs;
    // Only a failure that actually RAN gets a taxonomy category. Classifying
    // "No such app: nope" yields `unknown`, which is noise dressed as a
    // diagnosis — the request-shaped failures already say precisely what was
    // wrong in `code`.
    const category =
      code === 'run_failed' || code === 'timeout' ? classifyError({ message }).category : undefined;
    emit({
      schemaVersion: 1,
      ok: false,
      invocationId,
      app: opts.app,
      action: opts.action,
      durationMs,
      error: { code, category, message },
    });
    recordInvocation({
      invocationId,
      appId: opts.app,
      action: opts.action,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs,
      ok: false,
      errorCode: code,
      errorCategory: category,
      ...extra,
      // Reserved for #420: the capability handle this invocation was minted
      // from. Always null here, so correlating mint with invoke is a value
      // fill rather than a schema migration (R9).
      capabilityId: null,
    });
    return EXIT_FOR[code];
  };

  const raw = readRawArgs(opts);
  if (!raw.ok) return fail('invalid_args', raw.error);

  const registry = new AppRegistry();
  const resolved = resolveFromManifest(registry, opts.app, opts.action, raw.value);
  if (!resolved.ok) return fail(resolved.failure.kind, resolved.failure.message);

  const { invocation } = resolved;
  // The action DECLARED these; recorded so a log reader can see the scope.
  const toolsGranted = invocation.action.toolAllowlist;
  const argKeys = Object.keys(invocation.frozenArgs);

  // Pre-flight: an action naming a specialist that does not exist is a broken
  // manifest, not a failed run — the caller should see exit 2, and no model
  // call should be billed for it. `exists` rather than `get`, which reads and
  // parses the record only for its truthiness; `runHeadless` reads it properly
  // a moment later.
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
  });

  const run = await withStdoutRedirectedToStderr(() =>
    // The same id `runHeadless` will namespace its debug lines with, so
    // `script:mcp:ready` joins the invocation record rather than naming a run
    // that appears nowhere else.
    dispatchAction({ invocation, timeoutMs, log: diag, runId: invocationId }),
  );

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
    capabilityId: null,
  });

  emit({
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
  });
  return EXIT_OK;
}

/** Referenced for its type only; kept so the resolved record is the log's source. */
export type { ResolvedInvocation };
