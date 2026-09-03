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
import type { ConfirmActionInput } from './tools/types.js';
import type { ConfirmThreshold } from './risk.js';
import { shouldConfirm } from './risk.js';
import { thresholdForMode } from './policy/tool-mode.js';
import type { WriteScope } from './permissions/write-scope.js';
import type { PermissionRule } from './tool-permissions.js';
import { initShellParser } from './permissions/shell-ast.js';

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
  /** Resolved write scope — drives the write-scope gate. `null` = unrestricted. */
  writeScope: WriteScope | null;
  /**
   * Resolved permission rules — drive the deny gate (#420). `null` = none
   * apply, which is what every headless run did before apps existed.
   */
  toolPermissions: PermissionRule[] | null;
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
  /**
   * Where this run may write (#340), or `null` for no restriction.
   *
   * **Required, like the other two axes and for the same reason.** An optional
   * field would let a caller inherit "unrestricted" by omission — which is
   * exactly what happened: applet actions (`src/apps/dispatch.ts`) shipped
   * with no scope while being the *less* trusted origin. Stating `null` is a
   * decision; omitting a field is an accident.
   */
  writeScope: WriteScope | null;
  /**
   * Persisted permission rules this dispatch runs under (#420), or `null`.
   *
   * **Required, for the same reason as `writeScope`.** The rules an app runs
   * under are the app's own, granted by the user through `bernard app-grant`
   * — never `config.toolPermissions`, which holds the *user's* grants. An app
   * inheriting "always allow `shell rm *`" because a caller omitted a field is
   * precisely the confused-deputy widening #420 exists to prevent, so the
   * field cannot be omitted.
   *
   * Cron passes `null`: its jobs have never honoured profile grants, and that
   * stays true by being stated rather than by being the default.
   */
  toolPermissions: PermissionRule[] | null;
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

  // `skipPermissions` dissolves ALL gates, this one included. Leaving the
  // write scope in place would make a job the user explicitly marked
  // unrestricted still refuse `file_write` outside its workspace — while
  // `shell` in that same job stayed wide open, because shell DOES dissolve.
  // The net effect would be pushing the model toward the less safe tool.
  const writeScope: WriteScope | null = input.skipPermissions ? null : input.writeScope;

  // Dissolved by `skipPermissions` like every other gate — a run marked
  // unrestricted that still refused a denied tool would be the same
  // steer-toward-the-ungated-tool asymmetry the write scope had.
  const toolPermissions: PermissionRule[] | null = input.skipPermissions
    ? null
    : input.toolPermissions;

  const confirmThreshold: ConfirmThreshold = thresholdForMode(confirmMode);

  // Headless decision: approve unless the risk crosses the resolved threshold.
  // Reuses `shouldConfirm` (the canonical gate in augmentTools) so the
  // confirmMode → risk → allow/deny logic stays in one place.
  const confirmAction = async (i: ConfirmActionInput): Promise<boolean> =>
    !shouldConfirm(i.risk, confirmThreshold);

  return { toolMode, confirmMode, confirmThreshold, confirmAction, writeScope, toolPermissions };
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
      toolOptions: {
        shellTimeout: config.shellTimeout,
        // Unreachable, but required by ToolOptions — see
        // HeadlessPosture.confirmAction for why wiring confirmAction retires it.
        confirmDangerous: async () => false,
        confirmAction: posture.confirmAction,
        // Path scoping for writes (#340), resolved by `resolvePosture`
        // alongside the other two axes — so `skipPermissions` dissolves it too.
        ...(posture.writeScope ? { writeScope: posture.writeScope } : {}),
        // blockAction is intentionally omitted — this is headless and the augment
        // layer's fail-closed default (auto-deny when toolMode:'read-only' and no
        // blockAction is provided) is the correct behavior. When the policy
        // decision below sets mode:'read-only', write tool calls are auto-denied.
        // askUser intentionally omitted — no interactive user; the ask_user tool returns {unavailable}.
        // sessionToolAllowlist intentionally omitted — there is no session to
        // unlock a tool for.
        //
        // `getToolPermissions` is supplied only when the caller resolved rules
        // (#420). A live reader rather than a captured array, matching the
        // REPL, so an edit to a grant applies to the next dispatch with no
        // restart. `null` — cron — omits it, and `augmentTools` then reads no
        // rules at all, exactly as before apps existed.
        ...(posture.toolPermissions
          ? { getToolPermissions: () => posture.toolPermissions ?? [] }
          : {}),
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
