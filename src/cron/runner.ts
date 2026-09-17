import { debugLog } from '../logger.js';
import { runWorkspace } from '../paths.js';
import { CronStore } from './store.js';
import { CronLogStore, type CronLogStep } from './log-store.js';
import { CronNotesStore } from './notes-store.js';
import { sendNotification } from './notify.js';
import { classifyError } from '../error-taxonomy.js';
import { SpecialistStore } from '../specialists.js';
import { ToolProfileStore } from '../tool-profiles.js';
import type { CronJob } from './types.js';
import { definitions, type CronInput } from '../framework/agents/index.js';
import { renderAgentStatusPlain, type AgentStatusInputs } from '../agent-status.js';
import { verdictOf, type Check, type Verdict } from '../rubric.js';
import type { AgentContext } from '../framework/context.js';
import { runHeadless, resolvePosture, type HeadlessPosture } from '../headless.js';
import { declaredScope } from '../framework/agents/dispatch-profile.js';
import type { ToolErrorType } from '../framework/tools/types.js';

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
 *
 * Now an alias of the general {@link HeadlessPosture} (#419) — the shape was
 * never cron-specific, only the three fields it was derived from were.
 */
export type CronJobPermissionPosture = HeadlessPosture;

/**
 * Derives the per-job headless permission posture from a {@link CronJob}'s
 * optional `confirmMode`, `toolMode`, and `skipPermissions` fields.
 *
 * The resolution rules live in {@link resolvePosture}; this is the `CronJob`
 * projection onto them, kept as a named export because the daemon's callers and
 * tests address it by name.
 *
 * **Cron owns these two defaults, and they are cron's history rather than a
 * general policy.** `toolMode` defaults to `'write'` because every job that
 * exists opted in to writes at creation time; `confirmMode` defaults to
 * `'auto'` (deny high-risk, pass medium/low). A new headless entry point has no
 * such history and must not inherit them — which is why `resolvePosture`
 * requires both explicitly.
 */
export function resolveCronJobPosture(job: CronJob): CronJobPermissionPosture {
  return resolvePosture({
    toolMode: job.toolMode ?? 'write',
    confirmMode: job.confirmMode ?? 'auto',
    skipPermissions: job.skipPermissions,
    // The user's PROFILE grants are still `null` here, and the reason is
    // unchanged: they belong to a session the user is watching, and must not
    // leak into an unattended run. What is passed instead is the job's OWN
    // grants, named for this job by `bernard cron-grant --allow` — which is
    // what makes a job that needs `gh` expressible at all. `null` when there
    // are none, so `getToolPermissions` stays omitted and nothing is read.
    toolPermissions: job.toolPermissions?.length ? job.toolPermissions : null,
    // Path-scoped writes (#340). Every job gets its own workspace with no
    // configuration; `writePaths` adds locations the user named via
    // `bernard cron-grant`. This is what lets cron have the write-capable
    // file tools back at all — before it they were withheld wholesale (#337),
    // because a `medium`-risk arbitrary local write passed unprompted where a
    // write-shaped `shell` command was denied.
    writeScope: { workspace: runWorkspace('cron', job.id), grants: job.writePaths },
  });
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

/** Sums the per-step usage the step recorder accumulated during a run. */
function totalUsageOf(steps: CronLogStep[]): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  return steps.reduce(
    (acc, s) => ({
      promptTokens: acc.promptTokens + s.usage.promptTokens,
      completionTokens: acc.completionTokens + s.usage.completionTokens,
      totalTokens: acc.totalTokens + s.usage.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
}

/**
 * Per-run rubric inputs (#145). Cron has no plan store and no attestation
 * tracker target (no per-step `verification` strings), so the rubric is
 * composed from what the run actually produced: post-write hook outcomes plus
 * the most recent `evaluate` tool's structured checks.
 */
function rubricChecksOf(ctx: AgentContext): Check[] {
  return [...ctx.postWriteChecks, ...(ctx.verification.getLast()?.checks ?? [])];
}

/**
 * Executes a cron job by running the agent loop (with tools) against the
 * job's prompt.
 *
 * Since #419 the headless machinery — config, MCP lifecycle, context assembly,
 * the fail-closed `toolOptions`, the policy decision and the wall clock —
 * belongs to {@link runHeadless}, and this function owns only what is
 * genuinely cron: the job stores, the step accumulator that feeds the log
 * entry, the Agent Status appendix, the rubric, and the failure alert.
 *
 * @param job - The cron job definition to execute.
 * @param log - Callback for daemon-level logging.
 */
/**
 * The category a refused unattended run is filed under.
 *
 * `permission` from the shared taxonomy rather than a cron-only value: that is
 * exactly what happened, and widening `ToolErrorType` for one caller would put
 * a category in the table that `classifyError` can never produce. Doubles as
 * the repeat-alert key, since `lastErrorCategory` already records it.
 *
 * The taxonomy rates `permission` `critical`; this site rates the alert
 * `normal`, for the reason the timeout branch below states in reverse — cron
 * owns cron alerting, and a job that needs one grant is a task for later, not
 * an emergency.
 */
const DENIED_CATEGORY: ToolErrorType = 'permission';

/**
 * Finishes a run that completed but was refused a tool it needed (#447).
 *
 * Logged `success: false` with a `fail` check naming the tool, so the run log
 * and `cron-list` agree with what happened. The alert is raised only when the
 * previous run ended on a different category — see the call site for why.
 */
function finishDeniedRun(a: {
  job: CronJob;
  res: { denied: { tool: string; permissionKey: string | null; risk: string }[] };
  steps: CronLogStep[];
  runId: string;
  startedAt: string;
  completedAt: string;
  ctx: AgentContext;
  log: (msg: string) => void;
  logStore: CronLogStore;
  key: string;
  repeat: boolean;
}): RunJobResult {
  const store = new CronStore();
  const tools = [...new Set(a.res.denied.map((d) => d.permissionKey ?? d.tool))];
  const remedy = `bernard cron-grant ${a.job.id} --allow '${a.key}'`;
  const message =
    `Denied ${a.res.denied.length} tool call(s) this run: ${tools.join(', ')}. ` +
    `Nobody is present to approve them, so the answer will not change on the next fire. ` +
    `To let this job run it: ${remedy}`;

  try {
    a.logStore.appendEntry({
      runId: a.runId,
      jobId: a.job.id,
      jobName: a.job.name,
      prompt: a.job.prompt,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      durationMs: 0,
      success: false,
      finalOutput: message,
      steps: a.steps,
      totalUsage: totalUsageOf(a.steps),
      verdict: 'fail',
      rubricChecks: [
        ...rubricChecksOf(a.ctx),
        {
          id: 'tools_denied',
          label: 'a tool this job needed was refused',
          status: 'fail',
          evidence: tools.join(', '),
        },
      ],
    });
  } catch (logErr: unknown) {
    a.log(
      `Warning: failed to write execution log: ${logErr instanceof Error ? logErr.message : String(logErr)}`,
    );
  }

  try {
    store.updateJob(a.job.id, {
      lastErrorCategory: DENIED_CATEGORY,
      lastRunStatus: 'error',
      lastResult: message.slice(0, 2000),
    });
    if (a.repeat) {
      // Still `error`, just quiet. The first occurrence already said it, and
      // the remedy has not changed.
      a.log(`Job '${a.job.name}' denied ${tools.join(', ')} again — alert suppressed.`);
    } else {
      const alertRecord = store.createAlert({
        jobId: a.job.id,
        jobName: a.job.name,
        message,
        prompt: a.job.prompt,
        response: '',
      });
      sendNotification({
        title: `Bernard cron blocked: ${a.job.name}`,
        message: `${tools.join(', ')} denied — run: ${remedy}`,
        severity: 'normal',
        alertId: alertRecord.id,
        log: a.log,
      });
    }
  } catch (alertErr) {
    a.log(
      `Warning: failed to record denial: ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`,
    );
  }

  return { success: false, output: `Error: ${message}` };
}

export async function runJob(job: CronJob, log: (msg: string) => void): Promise<RunJobResult> {
  const store = new CronStore();
  const logStore = new CronLogStore();
  const notesStore = new CronNotesStore();
  const steps: CronLogStep[] = [];

  // --- Per-job permission posture (#260) ---
  const posture = resolveCronJobPosture(job);
  debugLog('cron:job:permissions', {
    jobId: job.id,
    jobToolMode: posture.toolMode,
    jobConfirmMode: posture.confirmMode,
    jobConfirmThreshold: posture.confirmThreshold,
    skipPermissions: job.skipPermissions ?? false,
  });

  const timeoutMs = resolveCronJobTimeoutMs(job);

  const res = await runHeadless<CronInput, string>({
    definition: () => definitions.get<CronInput, string>('cron'),
    posture,
    // RAG search using the job prompt as query (same scoping as before).
    ragQuery: job.prompt,
    // The job's own knowledge fences (#511), validated through the same
    // `declaredScope` a specialist record goes through. Unset means unscoped,
    // matching `toolMode`'s house rule that an unset field preserves legacy
    // behaviour and the job author opts in. Deny-by-default is the stronger
    // position in the abstract and is rejected here on purpose: silently
    // blanking every existing job's memory surfaces as "the job answered
    // worse", which is the quietest failure mode in this tree — and cron,
    // with no operator watching, is where it would be quietest.
    scope: declaredScope(job),
    timeoutMs,
    log,
    debugLabel: 'cron',
    // Cron's agent definition only touches ctx.stores.memory (see
    // src/framework/agents/cron.ts). Skip seeding for the two stores cron never
    // uses so the daemon doesn't race the REPL on first-run bundled-specialist
    // / tool-profile writes (issue #163).
    stores: {
      specialists: new SpecialistStore({ seed: false }),
      toolProfiles: new ToolProfileStore({ seed: false }),
    },
    buildInput: ({ mcp, ragResults, runId }) => ({
      job,
      runId,
      steps,
      store,
      notesStore,
      log,
      serverNames: mcp.serverNames,
      ragResults,
    }),
  });

  const { env, startedAt, timings } = res;
  const { ctx, runId } = env;
  const completedAt = new Date().toISOString();

  // A run that was refused its tools did not succeed, whatever the dispatch
  // did (#447). `success` elsewhere means "nothing threw", and for cron that
  // was indistinguishable from working: one job reported success ten times
  // while doing nothing, so nothing alerted, `cron-list` read clean, and
  // Bernard's own summary said "ran cleanly 10×".
  //
  // The alert is raised once per CATEGORY, not once per run. A read-only job
  // that merely probes a write would otherwise shout on every fire forever;
  // `lastErrorCategory` is already recorded, so a repeat still shows `error`
  // in `cron-list` and simply stops notifying. A changed category alerts again.
  if (res.ok && res.denied.length > 0) {
    const first = res.denied[0];
    const key = first.permissionKey ?? first.tool;
    const repeat = job.lastErrorCategory === DENIED_CATEGORY;
    return finishDeniedRun({
      job,
      res,
      steps,
      runId,
      startedAt,
      completedAt,
      ctx,
      log,
      logStore,
      key,
      repeat,
    });
  }

  if (res.ok) {
    const output = res.formatted;

    // Agent Status snapshot for cron parity with the interactive Shift+Tab
    // viewer (#140). Cron doesn't run the Policy Engine and doesn't expose a
    // plan store, so only the fields cron actually populates carry data;
    // everything else renders as `(none)`. Appended after the run's own output
    // so existing log readers still parse `finalOutput` cleanly.
    // Use the resolved per-job posture (#260) rather than global config so the
    // snapshot reflects the actual posture this run executed under.
    const statusInputs: AgentStatusInputs = {
      goal: job.prompt,
      permissions: {
        toolMode: posture.toolMode,
        confirmMode: posture.confirmMode,
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
      const rubricChecks = rubricChecksOf(ctx);
      const verdict: Verdict | undefined =
        rubricChecks.length > 0 ? verdictOf(rubricChecks) : undefined;
      logStore.appendEntry({
        runId,
        jobId: job.id,
        jobName: job.name,
        prompt: job.prompt,
        startedAt,
        completedAt,
        durationMs: timings.totalMs,
        success: true,
        finalOutput: finalOutputWithStatus,
        steps,
        totalUsage: totalUsageOf(steps),
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

    // Deliberately the BARE output — the log entry stores the status-appended
    // variant, these are intentionally different values.
    return { success: true, output };
  }

  // The wall clock fires runHeadless's controller, so the dispatch unwinds as a
  // bare AbortError with no context. Re-shape it here, where the budget and the
  // job record are in scope, into a message the taxonomy reads as `timeout`.
  const message = res.timedOut
    ? `Job timed out after ${res.timeoutMs} ms (job.timeoutMs / BERNARD_CRON_JOB_TIMEOUT_MS)`
    : res.error;
  const cls = classifyError({ message });
  // One decision, made once. `timeout` is severity `low` in the taxonomy —
  // right for an ordinary tool timeout, wrong for a job that was holding a
  // scheduler slot and queueing every later fire behind it with no operator
  // present. Cron owns cron alerting (`Classification.severity` is documented
  // on the interface as "Drives cron alert severity"), so this is decided at
  // the site that knows, rather than by teaching the shared table about cron.
  // Severity and the user-facing text are keyed on the same fact, so they are
  // resolved together — split apart, an edit to one reads as complete.
  const alert = res.timedOut
    ? {
        severity: 'critical' as const,
        text: `${cls.category} — the job hit its wall clock and was aborted; until then it was holding a scheduler slot.`,
      }
    : { severity: cls.severity, text: `${cls.category} — ${cls.playbook.user}` };

  try {
    // Failure branch always emits a `fail` verdict — the run threw, which is
    // itself the strongest signal that something is unverified. Whatever
    // post-write checks / evaluate checks accumulated before the throw still
    // ride along so the log has the partial picture.
    const failChecks: Check[] = [
      ...rubricChecksOf(ctx),
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
      completedAt,
      durationMs: timings.totalMs,
      success: false,
      error: message,
      errorCategory: cls.category,
      finalOutput: '',
      steps,
      totalUsage: totalUsageOf(steps),
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
}
