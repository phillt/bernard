import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { AppRegistry } from '../apps/registry.js';
import { invokeAction, type InvocationErrorCode, type InvocationResult } from '../apps/invoke.js';
import type { ParseResult } from '../apps/manifest.js';
import { withStdoutRedirectedToStderr } from './stdout-guard.js';

/**
 * `bernard script` — the programmatic entry point (#419).
 *
 * A caller supplies an app id, a named action and typed arguments, and gets
 * exactly one JSON object on stdout plus an exit code. Everything else — the
 * agent's own chatter, MCP connect notices, tool-profile lines — goes to
 * stderr, so `bernard script … | jq .result` works.
 *
 * Since #421 this file is a **CLI adapter**: the work lives in
 * `src/apps/invoke.ts`, which touches no process state so a concurrent HTTP
 * caller can share it. What stays here is everything that is genuinely about
 * being a command — argument reading, the stdout contract, exit codes.
 */

export const EXIT_OK = 0;
/** The work ran and failed. */
export const EXIT_RUN_FAILED = 1;
/** The request was malformed — nothing was dispatched. */
export const EXIT_BAD_REQUEST = 2;

/**
 * Everything the CLI can report, and the exit code each maps to.
 *
 * `InvocationErrorCode` covers what an invocation itself can fail as; the two
 * extra members are CLI-only — a missing flag, and a throw out of the command.
 *
 * A table rather than a comparison, so adding a code is a compile error until
 * its exit status is decided. The predecessor tested
 * `code === 'run_failed' || code === 'timeout'` inside the pre-dispatch helper
 * — where neither value can occur — so the arm that looked like the
 * classification rule was dead.
 *
 * The 1/2 split is the contract: `1` means the work failed and a retry might
 * help; `2` means the request was wrong and retrying it cannot.
 */
const EXIT_FOR: Record<ScriptErrorCode, number> = {
  unknown_app: EXIT_BAD_REQUEST,
  unknown_action: EXIT_BAD_REQUEST,
  invalid_manifest: EXIT_BAD_REQUEST,
  invalid_args: EXIT_BAD_REQUEST,
  unknown_specialist: EXIT_BAD_REQUEST,
  invalid_request: EXIT_BAD_REQUEST,
  internal_error: EXIT_BAD_REQUEST,
  run_failed: EXIT_RUN_FAILED,
  timeout: EXIT_RUN_FAILED,
};

export type ScriptErrorCode = InvocationErrorCode | 'invalid_request' | 'internal_error';

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
 * The CLI's own failure arm.
 *
 * Structurally `InvocationResult`'s failure member, widened only where the CLI
 * genuinely differs: its `code` set includes `invalid_request` and
 * `internal_error`, which no invocation can produce. Named rather than left as
 * `Record<string, unknown>` so `emit` stays closed — the alternative accepts
 * any object and stops typechecking the success path, which is how the
 * envelope drifted across five sites before #419.
 */
type CliFailure = Omit<Extract<InvocationResult, { ok: false }>, 'error'> & {
  error: { code: ScriptErrorCode; category?: string; message: string };
};

/** One JSON object, written to stdout, and nothing else ever is. */
function emit(result: InvocationResult | CliFailure): void {
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
 */
export async function scriptMain(options: ScriptCliOptions): Promise<number> {
  try {
    if (options.describe) {
      // `--describe` with no `--app` lists the registered apps; with one, it
      // prints that app's action schemas. This is what an applet host reads to
      // build its buttons, and what makes the closed registry inspectable
      // rather than something a caller has to guess at.
      return scriptDescribe(options.app);
    }
    if (!options.app || !options.action) {
      return emitError(
        'invalid_request',
        '--app and --action are required unless --describe is given.',
      );
    }
    // Commander coerces `--timeout` with a bare `parseInt`, so `--timeout foo`
    // arrives as `NaN`. Rejected here rather than absorbed: this is a
    // machine-facing entry point, and a caller that mistyped a budget wants
    // "your flag was wrong" rather than a run aborted instantly and reported
    // as a timeout — which is what happened, after paying for an MCP connect.
    if (
      options.timeout !== undefined &&
      !(Number.isFinite(options.timeout) && options.timeout > 0)
    ) {
      return emitError('invalid_request', '--timeout must be a positive number of milliseconds.');
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
  const raw = readRawArgs(opts);
  if (!raw.ok) {
    // Shaped like an invocation failure, but it never reached one — the args
    // could not be read, so there is nothing to invoke.
    return emitError('invalid_args', raw.error);
  }

  // The stdout guard stays on the CLI path ONLY. It monkey-patches
  // `process.stdout.write` process-globally, which is right for a one-shot
  // command and wrong for a server — two overlapping HTTP invocations would
  // nest and unwind the patch against each other. `invokeAction` itself
  // touches no process state, which is what makes it safe to share.
  const result = await withStdoutRedirectedToStderr(() =>
    invokeAction({
      appId: opts.app,
      action: opts.action,
      args: raw.value,
      timeoutMs: opts.timeoutMs,
      log: diag,
    }),
  );

  emit(result);
  return result.ok ? EXIT_OK : EXIT_FOR[result.error.code];
}
