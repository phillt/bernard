import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { loadConfig } from './config.js';
import { assembleContext } from './framework/context.js';
import type { AgentContext, AgentContextMCP, AgentContextStores } from './framework/context.js';
import { RAGStore, type RAGSearchResult } from './rag.js';
import { debugLog } from './logger.js';
import { MCPManager } from './mcp.js';
import { registerBuiltinDefinitions } from './framework/agents/index.js';
import { runDefinition } from './framework/agents/run.js';
import type { AgentDefinition } from './framework/agents/types.js';
import { initShellParser } from './permissions/shell-ast.js';

/**
 * The posture types and `resolvePosture` now live in `./headless-posture.ts`,
 * a leaf this module and `src/apps/tool-dispatch.ts` both import. Re-exported
 * here because every existing caller addresses them by this module's name.
 */
import { headlessToolOptions, type HeadlessPosture } from './headless-posture.js';

export {
  resolvePosture,
  headlessToolOptions,
  type HeadlessPosture,
  type HeadlessPostureInput,
} from './headless-posture.js';

/**
 * Everything a headless run assembles before it can build the dispatch input.
 *
 * Handed to {@link RunHeadlessOpts.buildInput} and returned on the result so a
 * caller can read the shared mutable state the run accumulated —
 * `ctx.postWriteChecks`, `ctx.verification.getLast()` — on both the success and
 * failure branches.
 */
export interface HeadlessEnv {
  ctx: AgentContext;
  mcp: AgentContextMCP;
  ragResults?: RAGSearchResult[];
  /** Correlation id for this run. Callers persist it in their own log entries. */
  runId: string;
}

export interface RunHeadlessOpts<TInput, TFormatted> {
  /**
   * Resolves the definition to run.
   *
   * A thunk rather than the definition itself because `runHeadless` owns
   * `registerBuiltinDefinitions()`, and `definitions.get(id)` THROWS on an
   * empty registry. Passing a value would mean every caller had to resolve
   * before calling — i.e. remember to register first — and the first refactor
   * onto this function tripped exactly that. Deferring the lookup makes the
   * ordering a property of the signature instead of a rule to remember.
   */
  definition: () => AgentDefinition<TInput, TFormatted>;
  /**
   * Builds the definition's per-call payload.
   *
   * A callback rather than "return the pieces and let the caller dispatch",
   * because `runHeadless` owns the MCP connect/close pair and the wall clock.
   * Handing the assembled context back would hand lifetime ownership back with
   * it — which is the shape this extraction exists to remove. It also runs
   * strictly after MCP connect and the RAG search, which is what a payload
   * naming `serverNames` / `ragResults` needs.
   */
  /**
   * May be async (#452). `apps/dispatch.ts` builds its tool registry here, and
   * `createTools` became async when the `main`-audience tool modules moved to
   * deferred imports — so the one caller that assembles tools inside
   * `buildInput` needs to await. Cron's implementor does not and is unaffected.
   */
  buildInput: (env: HeadlessEnv) => TInput | Promise<TInput>;
  posture: HeadlessPosture;
  /** Retrieval query. Omit to skip the RAG search entirely. */
  ragQuery?: string;
  /** Wall clock in ms. `null` disables it. */
  timeoutMs: number | null;
  /** The caller's own signal, composed with the wall clock. */
  abortSignal?: AbortSignal;
  /** Store overrides — e.g. cron's `seed: false` pair (#163). */
  stores?: Partial<AgentContextStores>;
  /** Progress sink. Never stdout for a machine-readable caller. */
  log: (msg: string) => void;
  /** Namespaces this run's `debugLog` lines, e.g. `'cron'` / `'script'`. */
  debugLabel: string;
  /**
   * Correlation id for this run. Supply one when the caller already mints an
   * id it persists in its own records — otherwise this function mints a fresh
   * one and the caller's log rows and these `debugLog` lines name different
   * runs, which is precisely the join a cold-start measurement needs.
   */
  runId?: string;
}

/** Timings every headless run reports, success or failure. */
export interface HeadlessTimings {
  /**
   * Cost of `MCPManager.connect()` + `snapshot()` (#419).
   *
   * Reported rather than merely logged because it is the number that decides
   * whether a per-invocation cold start is acceptable for an interactive
   * caller — `debugLog` is a no-op unless someone already suspected a problem.
   *
   * **Measured: ~1.1–1.6 s** across four stdio servers (google-mcp,
   * brave-search, playwright, browsermcp), against ~9–10 s for the whole
   * invocation. Roughly an eighth of a run that is dominated by model latency,
   * so a per-invocation connect is tolerable for a button press and the warm
   * path is genuinely deferrable rather than merely deferred.
   *
   * The warm path, when it is built: a long-lived `MCPManager` owned by the
   * per-user host service (#428), handed in as a pre-built `AgentContextMCP`
   * instead of being constructed here. Deliberately NOT built now — a "warm"
   * manager inside a per-invocation CLI process is a cache with a lifetime of
   * one call, and the process that could hold it does not exist yet. The
   * option shape is additive when it arrives.
   */
  mcpConnectMs: number;
  /** Wall time from entry to exit. */
  totalMs: number;
}

export type RunHeadlessResult<TFormatted> =
  | {
      ok: true;
      formatted: TFormatted;
      env: HeadlessEnv;
      startedAt: string;
      timings: HeadlessTimings;
      stepLimitHit: boolean;
    }
  | {
      ok: false;
      error: string;
      /** True when the wall clock fired, rather than the work failing. */
      timedOut: boolean;
      timeoutMs: number | null;
      env: HeadlessEnv;
      startedAt: string;
      timings: HeadlessTimings;
    };

/** Empty MCP snapshot used when no server connects. */
function emptyMCPSnapshot(): AgentContextMCP {
  return { tools: {}, serverNames: [], serverTools: {}, resolveAlias: () => null };
}

/**
 * Runs one agent definition with no user present.
 *
 * Owns the whole headless recipe: builtin registration, config load, RAG store
 * + fail-soft search, the MCP lifecycle (connect → snapshot → close in
 * `finally`), context assembly with the fail-closed headless `toolOptions`,
 * the `ctx.policyDecision` wiring, the wall clock, and the `runDefinition`
 * call. Extracted from `src/cron/runner.ts`'s `runJob` (#419), which is now one
 * caller of it.
 *
 * **It never throws.** A failed dispatch comes back as `{ok: false}` so each
 * caller can react in its own idiom — cron writes a log entry and fires a
 * desktop alert; `bernard script` emits JSON and sets an exit code.
 *
 * **It never classifies.** `classifyError` stays at the call site, because the
 * message a caller wants classified is one only it can mint: cron's timeout
 * text names `job.timeoutMs / BERNARD_CRON_JOB_TIMEOUT_MS` and escalates the
 * severity to `critical` because a hung job was holding a scheduler slot —
 * neither of which is true of a script invocation.
 */
export async function runHeadless<TInput, TFormatted>(
  opts: RunHeadlessOpts<TInput, TFormatted>,
): Promise<RunHeadlessResult<TFormatted>> {
  const { buildInput, posture, ragQuery, timeoutMs, log, debugLabel } = opts;

  registerBuiltinDefinitions();
  const config = loadConfig();

  // The bash parser (#261) is warmed only when this run actually carries
  // permission rules. It is reached solely through `resolveGrant`, and
  // `augmentTools` returns 'ask' before calling it when `getToolPermissions()`
  // yields none — so for a run with no rules the load is ~14 ms and ~1.6 MB of
  // WASM, retained for the process lifetime, on a path that cannot consult it.
  //
  // With rules it is not optional. Uninitialised, `parseShellCommand` falls
  // back to a regex that reports a compound command as `parse-error`, and
  // `resolveGrant` then matches only a no-specifier `shell` rule — so a
  // `deny shell:rm` would miss `ls && rm -rf /`. The degradation is safe for
  // `allow` and fail-OPEN for `deny`, which is the direction that matters here.
  // Awaited rather than fired off: a rule must not be evaluated against the
  // regex fallback because the WASM had not finished loading yet.
  if (posture.toolPermissions?.length) {
    await initShellParser();
  }

  const runId = opts.runId ?? crypto.randomUUID();

  // Created here rather than by each caller: a workspace that may not exist is
  // one every unattended writer has to remember to check, and forgetting reads
  // as "the grant did not work".
  if (posture.writeScope) {
    try {
      fs.mkdirSync(posture.writeScope.workspace, { recursive: true });
    } catch (err) {
      log(
        `Could not create the run workspace: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // Gated on `ragQuery`, not on `config.ragEnabled` alone. The constructor is
  // not a lazy handle: it reads and parses the whole embedding file, writes the
  // session date, prunes expired records and stats the temp dir — measured at
  // ~190 ms and ~128 MB on a 31 MB / 3,660-record store. A caller that never
  // retrieves (every `bernard script` action) paid all of it, and then held the
  // embeddings resident for the whole invocation via the returned `env`.
  let ragStore: RAGStore | undefined;
  let ragSearch: Promise<RAGSearchResult[] | undefined> | undefined;
  if (config.ragEnabled && ragQuery) {
    try {
      ragStore = new RAGStore();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`RAG initialization failed, continuing without RAG: ${msg}`);
    }
    // Started BEFORE the MCP connect below rather than after it. The two are
    // independent — the search needs only the store — and connect measures
    // ~1.1-1.6 s against four stdio servers while the first search pays a cold
    // MiniLM load. Awaited further down; `.catch` is attached here, at
    // creation, so an early rejection can never surface as unhandled.
    ragSearch = ragStore?.search(ragQuery).catch((err: unknown) => {
      debugLog(`${debugLabel}:rag:error`, err instanceof Error ? err.message : String(err));
      return undefined;
    });
  }

  const mcpManager = new MCPManager();
  let mcpSnapshot: AgentContextMCP = emptyMCPSnapshot();

  const mcpStartMs = Date.now();
  try {
    await mcpManager.connect();
    mcpSnapshot = mcpManager.snapshot({
      mode: config.mcpResultShaping,
      maxChars: config.mcpResultShapingMaxChars,
    });
    const { serverNames } = mcpSnapshot;
    if (serverNames.length > 0) {
      log(`MCP servers connected: ${serverNames.join(', ')}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`MCP initialization failed, continuing without MCP tools: ${message}`);
  }
  const mcpConnectMs = Date.now() - mcpStartMs;
  debugLog(`${debugLabel}:mcp:ready`, {
    runId,
    ms: mcpConnectMs,
    servers: mcpSnapshot.serverNames.length,
  });

  // Context assembly and the policy wiring sit between a CONNECTED MCP manager
  // and the `finally` that closes it, so a throw here would leak the manager's
  // stdio children — for the cron daemon, for the life of the process rather
  // than the life of one run. `runJob` had the same gap before #419; closing it
  // is the one deliberate behaviour change in the extraction.
  let ctx: AgentContext;
  try {
    ctx = assembleContext({
      config,
      toolOptions: headlessToolOptions(posture, config.shellTimeout),
      mcp: mcpSnapshot,
      rag: ragStore,
      stores: opts.stores,
    });

    // Wire the resolved posture into the policy decision so that
    // `runDefinition` → `augmentTools` sees the correct toolMode and
    // confirmThreshold. Without it augmentTools defaults to toolMode:'write' and
    // a threshold derived from confirmAction alone. Setting it here keeps the
    // two axes orthogonal: confirmMode:'off' does NOT bypass the read-only block
    // gate, because toolMode is consulted independently.
    ctx.policyDecision = {
      toolMode: {
        mode: posture.toolMode,
        requireConfirmForWrite: posture.confirmThreshold !== 'never',
        confirmThreshold: posture.confirmThreshold,
      },
    };
  } catch (err) {
    await mcpManager.close();
    throw err;
  }

  const ragResults = await ragSearch;
  if (ragResults && ragResults.length > 0) {
    debugLog(`${debugLabel}:rag`, {
      runId,
      query: ragQuery?.slice(0, 100),
      results: ragResults.length,
    });
  }

  const env: HeadlessEnv = { ctx, mcp: mcpSnapshot, ragResults, runId };
  const timings = (): HeadlessTimings => ({ mcpConnectMs, totalMs: Date.now() - startMs });

  // Wall clock (#326). Also the only `abortSignal` a headless run has, so
  // passing it additionally restores `runNonStreaming`'s defensive abort race,
  // which is skipped entirely when the signal is undefined.
  const abort = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs === null
      ? null
      : setTimeout(() => {
          timedOut = true;
          log(`Run exceeded its ${timeoutMs} ms wall clock — aborting.`);
          abort.abort();
        }, timeoutMs);
  timer?.unref?.();

  // Compose the caller's signal with the wall clock: either aborts the run.
  const onCallerAbort = () => abort.abort();
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) abort.abort();
    else opts.abortSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    const input = await buildInput(env);
    const { formatted, stepLimitHit } = await runDefinition(ctx, opts.definition(), input, {
      abortSignal: abort.signal,
    });
    return { ok: true, formatted, env, startedAt, timings: timings(), stepLimitHit };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error, timedOut, timeoutMs, env, startedAt, timings: timings() };
  } finally {
    if (timer) clearTimeout(timer);
    opts.abortSignal?.removeEventListener('abort', onCallerAbort);
    await mcpManager.close();
  }
}
