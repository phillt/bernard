import * as crypto from 'node:crypto';
import { loadConfig } from './config.js';
import type { BernardConfig } from './config.js';
import { initShellParser } from './permissions/shell-ast.js';
import { assembleContext } from './framework/context.js';
import type { AgentContext, AgentContextMCP, AgentContextStores } from './framework/context.js';
import { RAGStore, type RAGSearchResult } from './rag.js';
import { debugLog } from './logger.js';
import { MCPManager } from './mcp.js';
import { registerBuiltinDefinitions } from './framework/agents/index.js';
import { runDefinition } from './framework/agents/run.js';
import type { AgentDefinition } from './framework/agents/types.js';
import type { ConfirmActionInput } from './tools/types.js';
import type { ConfirmThreshold } from './risk.js';
import { shouldConfirm } from './risk.js';
import { thresholdForMode } from './policy/tool-mode.js';

/**
 * Resolved permission posture for one headless run.
 *
 * Extracted from `src/cron/runner.ts`'s `CronJobPermissionPosture` (#419) so
 * that cron is one caller of a general mechanism rather than the only place
 * Bernard knows how to run without a user present.
 */
export interface HeadlessPosture {
  /** Resolved tool gate mode — drives the block gate in `augmentTools`. */
  toolMode: 'read-only' | 'write';
  /** Resolved confirm mode label (for Agent Status snapshots). */
  confirmMode: 'off' | 'auto' | 'strict';
  /** Resolved confirm threshold — drives the confirm gate in `augmentTools`. */
  confirmThreshold: ConfirmThreshold;
  /**
   * Headless confirm action callback: auto-approves or auto-denies based on
   * `confirmThreshold` without ever prompting the user.
   *
   * Note: `shell.ts` only invokes `confirmDangerous` when `confirmAction` is
   * ABSENT (see the `!options.confirmAction` guard). Since a headless run
   * always wires `confirmAction`, dangerous shell commands are governed by
   * this callback (and by the `confirmThreshold` gate in `augmentTools` that
   * decides whether to call it at all). With default/auto posture the
   * threshold is 'high' and dangerous commands (risk:'high') are auto-denied
   * via this callback. With `skipPermissions:true` the threshold is 'never' so
   * this callback is never called and dangerous commands are allowed — the
   * caller opted in to "no safeguards" explicitly.
   */
  confirmAction: (input: ConfirmActionInput) => Promise<boolean>;
}

/**
 * The posture a caller is asking for.
 *
 * `toolMode` and `confirmMode` are REQUIRED, deliberately: this module owns the
 * rules, not the defaults. Cron's default is `write` because its jobs opted in
 * to writes at creation time (a legacy fact about cron records), while a
 * script action's default is `read-only` because an external caller has opted
 * in to nothing. Defaulting here would quietly make one entry point's history
 * the other's security posture.
 */
export interface HeadlessPostureInput {
  toolMode: 'read-only' | 'write';
  confirmMode: 'off' | 'auto' | 'strict';
  skipPermissions?: boolean;
}

/**
 * Derives a headless permission posture from a requested `toolMode`,
 * `confirmMode`, and the `skipPermissions` escape hatch.
 *
 * `skipPermissions === true` collapses both axes to write + off — all gates
 * dissolved, including dangerous-shell denial, because the caller explicitly
 * opted in to "no safeguards".
 *
 * Otherwise the two axes are intentionally orthogonal: `confirmMode:'off'`
 * (threshold `'never'`) does NOT bypass the `toolMode:'read-only'` block gate.
 * The block gate is driven by `toolMode`; the confirm gate is driven by
 * `confirmThreshold`. Both are wired independently into `augmentTools` via
 * `ctx.policyDecision.toolMode`.
 *
 * Uses the canonical `thresholdForMode` from `src/policy/tool-mode.ts` so the
 * `confirmMode → ConfirmThreshold` mapping stays in one place.
 */
export function resolvePosture(input: HeadlessPostureInput): HeadlessPosture {
  const toolMode: 'read-only' | 'write' = input.skipPermissions ? 'write' : input.toolMode;

  const confirmMode: 'off' | 'auto' | 'strict' = input.skipPermissions ? 'off' : input.confirmMode;

  const confirmThreshold: ConfirmThreshold = thresholdForMode(confirmMode);

  // Headless decision: approve unless the risk crosses the resolved threshold.
  // Reuses `shouldConfirm` (the canonical gate in augmentTools) so the
  // confirmMode → risk → allow/deny logic stays in one place.
  const confirmAction = async (i: ConfirmActionInput): Promise<boolean> =>
    !shouldConfirm(i.risk, confirmThreshold);

  return { toolMode, confirmMode, confirmThreshold, confirmAction };
}

/**
 * Everything a headless run assembles before it can build the dispatch input.
 *
 * Handed to {@link RunHeadlessOpts.buildInput} and returned on the result so a
 * caller can read the shared mutable state the run accumulated —
 * `ctx.postWriteChecks`, `ctx.verification.getLast()` — on both the success and
 * failure branches.
 */
export interface HeadlessEnv {
  config: BernardConfig;
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
  buildInput: (env: HeadlessEnv) => TInput;
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
  // Warm the bash parser in the background (#261). A headless run carries no
  // profile rules so the parser isn't consulted for matching, and
  // dangerous-command detection uses regex — so this never needs to block.
  void initShellParser();
  const config = loadConfig();

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  let ragStore: RAGStore | undefined;
  if (config.ragEnabled) {
    try {
      ragStore = new RAGStore();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`RAG initialization failed, continuing without RAG: ${msg}`);
    }
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
      toolOptions: {
        shellTimeout: config.shellTimeout,
        // confirmDangerous is the fallback inside shell.ts for when confirmAction
        // is absent. Because a headless run always wires confirmAction below,
        // this callback is never reached — but ToolOptions requires it, so
        // supply a safe default.
        confirmDangerous: async () => false,
        // Headless confirm gate. augmentTools reads the confirm threshold from
        // ctx.policyDecision (set below) to decide whether to call this; the
        // callback's own risk check is a defence-in-depth fallback.
        confirmAction: posture.confirmAction,
        // blockAction is intentionally omitted — this is headless and the augment
        // layer's fail-closed default (auto-deny when toolMode:'read-only' and no
        // blockAction is provided) is the correct behavior. When the policy
        // decision below sets mode:'read-only', write tool calls are auto-denied.
        // askUser intentionally omitted — no interactive user; the ask_user tool returns {unavailable}.
        // getToolPermissions and sessionToolAllowlist intentionally omitted —
        // a headless run never honours profile grants or per-session unlocks.
      },
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

  let ragResults: RAGSearchResult[] | undefined;
  if (ragStore && ragQuery) {
    try {
      ragResults = await ragStore.search(ragQuery);
      if (ragResults.length > 0) {
        debugLog(`${debugLabel}:rag`, {
          runId,
          query: ragQuery.slice(0, 100),
          results: ragResults.length,
        });
      }
    } catch (err) {
      debugLog(`${debugLabel}:rag:error`, err instanceof Error ? err.message : String(err));
    }
  }

  const env: HeadlessEnv = { config, ctx, mcp: mcpSnapshot, ragResults, runId };
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
    const input = buildInput(env);
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
