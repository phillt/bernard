import * as crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import { initShellParser } from '../permissions/shell-ast.js';
import { assembleContext } from '../framework/context.js';
import { RAGStore, type RAGSearchResult } from '../rag.js';
import { debugLog } from '../logger.js';
import type { AgentContextMCP } from '../framework/context.js';
import { MCPManager } from '../mcp.js';
import { CronStore } from './store.js';
import { CronLogStore, type CronLogStep } from './log-store.js';
import { CronNotesStore } from './notes-store.js';
import { sendNotification } from './notify.js';
import { classifyError } from '../error-taxonomy.js';
import { SpecialistStore } from '../specialists.js';
import { ToolProfileStore } from '../tool-profiles.js';
import type { CronJob } from './types.js';
import {
  definitions,
  registerBuiltinDefinitions,
  type CronInput,
} from '../framework/agents/index.js';
import { runDefinition } from '../framework/agents/run.js';
import { renderAgentStatusPlain, type AgentStatusInputs } from '../agent-status.js';
import { verdictOf, type Check, type Verdict } from '../rubric.js';
import type { ConfirmActionInput } from '../tools/types.js';
import type { ConfirmThreshold } from '../risk.js';
import { shouldConfirm } from '../risk.js';
import { thresholdForMode } from '../policy/tool-mode.js';

export {
  /** Re-exported so existing imports against the runner module keep working. */
  DAEMON_SYSTEM_PROMPT,
} from '../framework/agents/cron.js';

/** Outcome of a single cron job execution. */
export interface RunJobResult {
  success: boolean;
  output: string;
}

/**
 * Resolved headless permission posture for a single cron job run.
 * Exported for unit testing.
 */
export interface CronJobPermissionPosture {
  /** Resolved tool gate mode — drives the block gate in augmentTools. */
  toolMode: 'read-only' | 'write';
  /** Resolved confirm mode label (for Agent Status snapshot). */
  confirmMode: 'off' | 'auto' | 'strict';
  /** Resolved confirm threshold — drives the confirm gate in augmentTools. */
  confirmThreshold: ConfirmThreshold;
  /**
   * Headless confirm action callback: auto-approves or auto-denies based on
   * `confirmThreshold` without ever prompting the user.
   *
   * Note: shell.ts only invokes `confirmDangerous` when `confirmAction` is
   * ABSENT (see the `!options.confirmAction` guard). Since cron always wires
   * `confirmAction`, dangerous shell commands are governed by this callback
   * (and by the `confirmThreshold` gate in augmentTools that decides whether
   * to call it at all). With default/auto posture the threshold is 'high' and
   * dangerous commands (risk:'high') are auto-denied via this callback.
   * With `skipPermissions:true` the threshold is 'never' so this callback is
   * never called and dangerous commands are allowed — the user opted the job
   * in to "no safeguards" explicitly.
   */
  confirmAction: (input: ConfirmActionInput) => Promise<boolean>;
}

/**
 * Derives the per-job headless permission posture from a {@link CronJob}'s
 * optional `confirmMode`, `toolMode`, and `skipPermissions` fields.
 *
 * Resolution rules (evaluated in order):
 * 1. `skipPermissions === true` → write + off (all gates dissolved, including
 *    dangerous-shell denial — the user explicitly opted in to "no safeguards").
 * 2. `toolMode` defaults to `'write'` (legacy: jobs opted in at creation).
 * 3. `confirmMode` defaults to `'auto'` (deny high-risk, pass medium/low).
 *
 * The two axes are intentionally orthogonal: `confirmMode:'off'` (threshold
 * `'never'`) does NOT bypass the `toolMode:'read-only'` block gate. The
 * block gate is driven by `toolMode`; the confirm gate is driven by
 * `confirmThreshold`. Both are wired independently into `augmentTools` via
 * `ctx.policyDecision.toolMode`.
 *
 * Uses the canonical `thresholdForMode` from `src/policy/tool-mode.ts` so
 * the `confirmMode → ConfirmThreshold` mapping stays in one place.
 */
export function resolveCronJobPosture(job: CronJob): CronJobPermissionPosture {
  const toolMode: 'read-only' | 'write' = job.skipPermissions ? 'write' : (job.toolMode ?? 'write');

  const confirmMode: 'off' | 'auto' | 'strict' = job.skipPermissions
    ? 'off'
    : (job.confirmMode ?? 'auto');

  const confirmThreshold: ConfirmThreshold = thresholdForMode(confirmMode);

  // Headless decision: approve unless the risk crosses the resolved threshold.
  // Reuses `shouldConfirm` (the canonical gate in augmentTools) so the
  // confirmMode → risk → allow/deny logic stays in one place.
  const confirmAction = async (input: ConfirmActionInput): Promise<boolean> =>
    !shouldConfirm(input.risk, confirmThreshold);

  return { toolMode, confirmMode, confirmThreshold, confirmAction };
}

/**
 * Default per-job wall clock (#326). Generous — a legitimate cron job can
 * research or build for a long time — but finite, because the cost of an
 * unbounded one is not "this job is slow", it is "the scheduler stopped".
 */
const DEFAULT_CRON_JOB_TIMEOUT_MS = 30 * 60_000;

/**
 * Resolves the wall clock for one job: per-job `timeoutMs` wins, then
 * `BERNARD_CRON_JOB_TIMEOUT_MS`, then {@link DEFAULT_CRON_JOB_TIMEOUT_MS}. `0`
 * (at either level) disables it.
 *
 * Defaulted rather than opt-in on purpose: every job that exists today
 * predates this field, and those are exactly the ones currently able to wedge
 * the scheduler.
 */
export function resolveCronJobTimeoutMs(job: CronJob): number | null {
  if (job.timeoutMs !== undefined) {
    return job.timeoutMs > 0 ? Math.floor(job.timeoutMs) : null;
  }
  // An empty/absent var means "unset", NOT "disabled". `Number('')` is `0`,
  // which is finite and non-positive — so reading the env through `Number()`
  // without this guard made `BERNARD_CRON_JOB_TIMEOUT_MS=` silently turn off
  // the very clock this exists to add.
  const raw = process.env.BERNARD_CRON_JOB_TIMEOUT_MS;
  if (!raw) return DEFAULT_CRON_JOB_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CRON_JOB_TIMEOUT_MS;
  return n > 0 ? Math.floor(n) : null;
}

/**
 * Executes a cron job by running the agent loop (with tools) against the
 * job's prompt. Sets up the runtime context (MCP, RAG, stores), delegates the
 * actual agent loop to {@link cronDefinition} via `runDefinition`, then
 * writes a structured log entry to {@link CronLogStore}.
 *
 * @param job - The cron job definition to execute.
 * @param log - Callback for daemon-level logging.
 */
export async function runJob(job: CronJob, log: (msg: string) => void): Promise<RunJobResult> {
  registerBuiltinDefinitions();
  // Warm the bash parser in the background (#261). Cron carries no profile
  // rules so the parser isn't consulted for matching, and dangerous-command
  // detection uses regex — so this never needs to block job startup.
  void initShellParser();
  const config = loadConfig();
  const store = new CronStore();

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
  let mcpSnapshot: AgentContextMCP = {
    tools: {},
    serverNames: [],
    serverTools: {},
    resolveAlias: () => null,
  };

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

  // --- Per-job permission posture (#260) ---
  const {
    toolMode: jobToolMode,
    confirmMode: jobConfirmMode,
    confirmThreshold: jobConfirmThreshold,
    confirmAction: jobConfirmAction,
  } = resolveCronJobPosture(job);

  debugLog('cron:job:permissions', {
    jobId: job.id,
    jobToolMode,
    jobConfirmMode,
    jobConfirmThreshold,
    skipPermissions: job.skipPermissions ?? false,
  });

  const ctx = assembleContext({
    config,
    toolOptions: {
      shellTimeout: config.shellTimeout,
      // confirmDangerous is the fallback inside shell.ts for when confirmAction
      // is absent. Because cron always wires confirmAction below, this callback
      // is never reached — but ToolOptions requires it, so supply a safe default.
      confirmDangerous: async () => false,
      // Headless confirm gate. augmentTools reads jobConfirmThreshold from
      // ctx.policyDecision (set below) to decide whether to call this; the
      // callback's own risk check is a defence-in-depth fallback.
      confirmAction: jobConfirmAction,
      // blockAction is intentionally omitted — cron is headless and the augment
      // layer's fail-closed default (auto-deny when toolMode:'read-only' and no
      // blockAction is provided) is the correct headless behavior. When the policy
      // decision below sets mode:'read-only', write tool calls are auto-denied.
      // askUser intentionally omitted — no interactive user; the ask_user tool returns {unavailable}.
    },
    mcp: mcpSnapshot,
    rag: ragStore,
    // Cron's agent definition only touches ctx.stores.memory (see src/framework/agents/cron.ts).
    // Skip seeding for the two stores cron never uses so the daemon doesn't race the REPL on
    // first-run bundled-specialist / tool-profile writes (issue #163).
    stores: {
      specialists: new SpecialistStore({ seed: false }),
      toolProfiles: new ToolProfileStore({ seed: false }),
    },
  });

  // Wire the per-job permission posture into the policy decision so that
  // `runDefinition` → `augmentTools` sees the correct toolMode and
  // confirmThreshold. Cron normally runs without a policyDecision (undefined),
  // which causes augmentTools to default to toolMode:'write' and
  // confirmThreshold derived from confirmAction alone. Setting it here keeps
  // the two axes orthogonal: confirmMode:'off' does NOT bypass the read-only
  // block gate because toolMode is consulted independently.
  ctx.policyDecision = {
    toolMode: {
      mode: jobToolMode,
      requireConfirmForWrite: jobConfirmThreshold !== 'never',
      confirmThreshold: jobConfirmThreshold,
    },
  };

  const logStore = new CronLogStore();
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const steps: CronLogStep[] = [];
  const notesStore = new CronNotesStore();

  // RAG search using job prompt as query (same scoping as the previous inline runner).
  let ragResults: RAGSearchResult[] | undefined;
  if (ragStore) {
    try {
      ragResults = await ragStore.search(job.prompt);
      if (ragResults.length > 0) {
        debugLog('cron:rag', {
          jobId: job.id,
          query: job.prompt.slice(0, 100),
          results: ragResults.length,
        });
      }
    } catch (err) {
      debugLog('cron:rag:error', err instanceof Error ? err.message : String(err));
    }
  }

  // Per-job wall clock (#326). Also the only `abortSignal` cron has ever had,
  // so passing it additionally restores `runNonStreaming`'s defensive abort
  // race — skipped entirely when the signal is undefined, which meant headless
  // runs had *less* protection than interactive ones.
  const jobTimeoutMs = resolveCronJobTimeoutMs(job);
  const jobAbort = new AbortController();
  let jobTimedOut = false;
  const jobTimer =
    jobTimeoutMs === null
      ? null
      : setTimeout(() => {
          jobTimedOut = true;
          log(`Job "${job.name}" exceeded its ${jobTimeoutMs} ms wall clock — aborting.`);
          jobAbort.abort();
        }, jobTimeoutMs);
  jobTimer?.unref?.();

  try {
    const def = definitions.get<CronInput, string>('cron');
    const input: CronInput = {
      job,
      runId,
      steps,
      store,
      notesStore,
      log,
      serverNames: mcpSnapshot.serverNames,
      ragResults,
    };
    const { formatted: output } = await runDefinition(ctx, def, input, {
      abortSignal: jobAbort.signal,
    });

    // Agent Status snapshot for cron parity with the interactive Shift+Tab
    // viewer (#140). Cron doesn't run the Policy Engine and doesn't expose a
    // plan store, so only the fields cron actually populates carry data;
    // everything else renders as `(none)`. Appended after the run's own output
    // so existing log readers still parse `finalOutput` cleanly.
    // Use per-job resolved values (#260) rather than global config so the
    // snapshot reflects the actual posture this run executed under.
    const statusInputs: AgentStatusInputs = {
      goal: job.prompt,
      permissions: {
        toolMode: jobToolMode,
        confirmMode: jobConfirmMode as 'off' | 'auto' | 'strict',
        sessionAllowedCount: 0,
      },
      constraints: null,
      assumptions: [],
      planStep: null,
      planSummary: { done: 0, total: 0 },
      lastVerification: ctx.verification.getLast(),
    };
    const finalOutputWithStatus = `${output}\n\n--- Agent Status ---\n${renderAgentStatusPlain(statusInputs)}`;

    try {
      const totalUsage = steps.reduce(
        (acc, s) => ({
          promptTokens: acc.promptTokens + s.usage.promptTokens,
          completionTokens: acc.completionTokens + s.usage.completionTokens,
          totalTokens: acc.totalTokens + s.usage.totalTokens,
        }),
        { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      );
      // Per-run rubric (#145). Cron has no plan store and no attestation
      // tracker target (no per-step `verification` strings), so we compose from
      // what the run actually produced: post-write hook outcomes + the most
      // recent `evaluate` tool's structured checks. Logged whether or not any
      // checks were recorded — older readers tolerate missing fields.
      const evalChecks = ctx.verification.getLast()?.checks ?? [];
      const rubricChecks: Check[] = [...ctx.postWriteChecks, ...evalChecks];
      const verdict: Verdict | undefined =
        rubricChecks.length > 0 ? verdictOf(rubricChecks) : undefined;
      logStore.appendEntry({
        runId,
        jobId: job.id,
        jobName: job.name,
        prompt: job.prompt,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        success: true,
        finalOutput: finalOutputWithStatus,
        steps,
        totalUsage,
        verdict,
        rubricChecks: rubricChecks.length > 0 ? rubricChecks : undefined,
      });
      // A clean-running job that nevertheless trips at least one warn-grade
      // check is invisible to today's success/error alert routing. Log a
      // structured warn line so the daemon log surfaces it.
      if (verdict === 'warn') {
        log(`Warning: job '${job.name}' completed but rubric verdict is WARN.`);
      }
    } catch (logErr: unknown) {
      const logMsg = logErr instanceof Error ? logErr.message : String(logErr);
      log(`Warning: failed to write execution log: ${logMsg}`);
    }

    return { success: true, output };
  } catch (err: unknown) {
    // The wall clock fires our own controller, so the dispatch unwinds as a
    // bare AbortError with no context. Re-shape it here, where the budget is
    // still in scope, into a message the taxonomy reads as `timeout`.
    const message = jobTimedOut
      ? `Job timed out after ${jobTimeoutMs} ms (job.timeoutMs / BERNARD_CRON_JOB_TIMEOUT_MS)`
      : err instanceof Error
        ? err.message
        : String(err);
    const cls = classifyError({ message });
    // One decision, made once. `timeout` is severity `low` in the taxonomy —
    // right for an ordinary tool timeout, wrong for a job that was holding a
    // scheduler slot and queueing every later fire behind it with no operator
    // present. Cron owns cron alerting (`Classification.severity` is
    // documented on the interface as "Drives cron alert severity"), so this is
    // decided at the site that knows, rather than by teaching the shared table
    // about cron. Severity and the user-facing text are keyed on the same
    // fact, so they are resolved together — split apart, an edit to one
    // reads as complete.
    const alert = jobTimedOut
      ? {
          severity: 'critical' as const,
          text: `${cls.category} — the job hit its wall clock and was aborted; until then it was holding a scheduler slot.`,
        }
      : { severity: cls.severity, text: `${cls.category} — ${cls.playbook.user}` };

    try {
      const totalUsage = steps.reduce(
        (acc, s) => ({
          promptTokens: acc.promptTokens + s.usage.promptTokens,
          completionTokens: acc.completionTokens + s.usage.completionTokens,
          totalTokens: acc.totalTokens + s.usage.totalTokens,
        }),
        { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      );
      // Failure branch always emits a `fail` verdict — the run threw, which
      // is itself the strongest signal that something is unverified.
      // Whatever post-write checks / evaluate checks accumulated before the
      // throw still ride along so the log has the partial picture.
      const evalChecksOnFail = ctx.verification.getLast()?.checks ?? [];
      const failChecks: Check[] = [
        ...ctx.postWriteChecks,
        ...evalChecksOnFail,
        {
          id: 'run_threw',
          label: 'job raised an exception',
          status: 'fail',
          evidence: cls.category,
        },
      ];
      logStore.appendEntry({
        runId,
        jobId: job.id,
        jobName: job.name,
        prompt: job.prompt,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        success: false,
        error: message,
        errorCategory: cls.category,
        finalOutput: '',
        steps,
        totalUsage,
        verdict: 'fail',
        rubricChecks: failChecks,
      });
    } catch {
      // best-effort logging
    }

    // Best-effort failure alert. Headless cron has no user looking at stdout,
    // so the desktop notification is how the user finds out something broke.
    // Severity comes straight from the taxonomy: auth/permission ring loud,
    // transient/rate-limit ring quiet.
    //
    // Write `lastRunStatus: 'error'` here (rather than waiting for the
    // scheduler's post-runJob update) so the alert and the user's first /cron
    // status read see a consistent terminal state — otherwise a notification
    // can arrive while jobs.json still reads `lastRunStatus: 'running'`.
    try {
      store.updateJob(job.id, {
        lastErrorCategory: cls.category,
        lastRunStatus: 'error',
        lastResult: message.slice(0, 2000),
      });
      const alertRecord = store.createAlert({
        jobId: job.id,
        jobName: job.name,
        message: `${cls.category}: ${message.split('\n')[0].slice(0, 200)}`,
        prompt: job.prompt,
        response: '',
      });
      sendNotification({
        title: `Bernard cron failed: ${job.name}`,
        message: alert.text,
        severity: alert.severity,
        alertId: alertRecord.id,
        log,
      });
    } catch (alertErr) {
      log(
        `Warning: failed to send failure alert: ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`,
      );
    }

    return { success: false, output: `Error: ${message}` };
  } finally {
    if (jobTimer) clearTimeout(jobTimer);
    await mcpManager.close();
  }
}
