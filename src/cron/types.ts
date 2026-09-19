import type { ScopeSelection } from '../framework/agents/dispatch-profile.js';
import type { ToolErrorType } from '../framework/tools/types.js';
import type { PermissionRule } from '../tool-permissions.js';

/**
 * A recurring task that Bernard executes on a cron schedule.
 *
 * `extends ScopeSelection` carries the knowledge fences (#511, #516) — the same
 * three fields `Specialist` and `DispatchProfile` declare, inherited rather
 * than copied so a fourth axis reaches cron for free (#552). That is already
 * how this job type got its corpus fence: `cron/runner.ts` passes the whole
 * record and names no axis.
 *
 * **Unset means unscoped**, matching `toolMode`'s house rule below: an unset
 * posture field preserves legacy behaviour and the job author opts in.
 * Deny-by-default is the stronger security position in the abstract and is
 * deliberately rejected here — silently blanking every existing job's memory
 * overnight surfaces as "the job answered worse", which #510 already records as
 * the quietest failure mode in this repo, and cron is where it would be
 * quietest. The RAG fence is orthogonal to `prompt`, which bounds retrieval by
 * SIMILARITY: that is not a fence and was never claimed to be, and the two
 * multiply.
 */
export interface CronJob extends ScopeSelection {
  /** Unique identifier (UUID). */
  id: string;
  /** Human-readable label for the job. */
  name: string;
  /** Cron expression (e.g. "0 * * * *") defining when the job runs. */
  schedule: string;
  /** The prompt sent to the agent when the job fires. */
  prompt: string;
  /** Whether the job is active; disabled jobs are skipped by the scheduler. */
  enabled: boolean;
  /** ISO-8601 timestamp of when the job was created. */
  createdAt: string;
  /** ISO-8601 timestamp of the most recent execution, if any. */
  lastRun?: string;
  /** Outcome of the most recent execution. */
  lastRunStatus?: 'success' | 'error' | 'running';
  /** Truncated agent response from the most recent execution. */
  lastResult?: string;
  /** Failure-taxonomy category from the most recent failed execution, if any. */
  lastErrorCategory?: ToolErrorType;
  /**
   * Per-job risk-based confirmation posture. Mirrors `BernardConfig.confirmMode`.
   * When unset, defaults to `'auto'` (deny high-risk, pass through the rest).
   * - `'off'`    — auto-approve all tool calls regardless of risk (but still
   *                subject to `toolMode` — an `'off'` job with `toolMode:
   *                'read-only'` still blocks write tools headlessly).
   * - `'auto'`   — deny high-risk calls; pass through medium/low (legacy default).
   * - `'strict'` — deny both high- and medium-risk calls.
   */
  confirmMode?: 'off' | 'auto' | 'strict';
  /**
   * Per-job least-privilege tool gate. Mirrors `BernardConfig.toolMode`.
   * When unset, defaults to `'write'` (no block gate) — preserving legacy
   * behavior where cron jobs opted in to write operations at creation time.
   * Set to `'read-only'` to prevent the agent from invoking any write or
   * dangerous tool during this job's run.
   */
  toolMode?: 'read-only' | 'write';
  /**
   * Per-job "run without any permission checks or safeguards" flag. Mirrors
   * `BernardConfig.skipPermissions`. When true, both the `toolMode` block
   * gate and the `confirmMode` confirmation gate are dissolved — every tool
   * call proceeds without restriction. Takes precedence over `confirmMode`
   * and `toolMode`.
   */
  skipPermissions?: boolean;
  /**
   * Per-job tool grants, written only by `bernard cron-grant --allow`.
   *
   * The precise lever for "this job may run one thing it otherwise could not".
   * `runGate` opens with `if (grant === 'allow') return true`, so a rule of
   * `allow shell:gh` clears the confirm gate for `gh` **and nothing else** —
   * where `confirmMode: 'off'`, the only other reachable knob, dissolves every
   * confirmation including `rm -rf`.
   *
   * It exists because a job that needed `gh issue create` could not be
   * expressed at all: cron's default denies every write-shaped shell command,
   * and one real job burned ten scheduled runs and 934,805 tokens discovering
   * that, with no way for anyone to fix it short of hand-editing `jobs.json`.
   *
   * **Not the user's profile grants**, which `resolveCronJobPosture` still
   * passes as `null` — those belong to a session the user is watching. These
   * are the job's own, named for the job. And deliberately absent from the
   * `cron` tool: `cli.ts` already states the rule for write paths — letting an
   * agent widen its own authority is the escalation the gate exists to
   * prevent — and it applies identically here.
   */
  toolPermissions?: PermissionRule[];
  /**
   * Per-job wall clock in milliseconds (#326). Falls back to
   * `BERNARD_CRON_JOB_TIMEOUT_MS`, then to a 30-minute default; `0` disables
   * the clock for this job.
   *
   * Cron used to call `runDefinition` with no `abortSignal` — it had none to
   * give — and nothing else in `src/cron/` was a job-level clock (`shellTimeout`
   * is per-tool). A hung job therefore held its scheduler slot forever, and
   * once `runningCount` reached `maxConcurrent` every later fire queued behind
   * it with no way to drain, because `drainQueue` only runs from a completing
   * job's `finally`. One stuck job silently stopped the whole scheduler with no
   * operator present.
   */
  timeoutMs?: number;
  /**
   * Run one missed fire when the clock has moved past a boundary (#400).
   *
   * Unset means off, preserving the behaviour every existing job was created
   * under: a fire the daemon slept through is recorded and dropped. Whether that
   * is right is a property of the job and nothing else can guess it — a monitor
   * ("check the replies every two hours") wants the late run, because running
   * late is the whole point and not running at all is the failure; a scheduled
   * action ("send the morning summary at 8") does not, because firing at 3pm is
   * worse than skipping.
   *
   * **At most one run, however many were missed.** A laptop shut over a weekend
   * owes an hourly monitor 60 fires; replaying them would be 60 passes over the
   * same inbox, 60 dispatches against a pool of three, and 60 lots of tokens to
   * reach the answer the first one already gives. The state the job reports on
   * is current state.
   *
   * Settable by the `cron` tool, unlike `writePaths` and `toolPermissions`. Those
   * are authority — `cli.ts` states the rule that a model must not widen what it
   * may do — and this is not: a caught-up run executes under exactly the posture
   * the job already had. It changes *when*, never *what*.
   */
  catchUp?: boolean;
  /**
   * The boundary the scheduler is currently waiting for, ISO-8601 (#400).
   *
   * Persisted rather than held in memory so a daemon that was stopped — or a
   * machine that was off — is a missed fire like any other on restart, instead
   * of silently re-seeding from "now" and reporting nothing. Written by the
   * scheduler only; a hand-edited value simply moves the next fire.
   */
  nextRunAt?: string;
  /**
   * Boundaries that passed without producing a run, since the last on-time run.
   *
   * Reset to zero by an on-time run rather than accumulated forever, so the
   * number answers "how much has this job dropped lately" — which is
   * actionable — rather than "since when?", which is not. A job on a mostly
   * sleeping laptop keeps a standing count, and that is the signal.
   */
  missedRuns?: number;
  /** ISO-8601 timestamp of when a missed fire was last noticed. */
  lastMissedAt?: string;
  /**
   * Extra locations this job may write to, beyond its own workspace (#340).
   *
   * Absolute paths; a directory grants its whole subtree. Every job always
   * gets `<CRON_WORKSPACE_DIR>/<job id>` with no configuration, so this is
   * only for writes that must land somewhere the user names — the case the
   * workspace deliberately does not cover.
   *
   * The grant is enforced per *dispatch* rather than per job record, because
   * cron is not the only unattended writer: an applet action (#445) is
   * triggered from a browser with a caller supplying the arguments. This field
   * is cron's way of populating a general mechanism, not a cron-specific one.
   */
  writePaths?: string[];
}

/** A notification generated when a cron job completes and produces output. */
export interface CronAlert {
  /** Unique identifier (UUID). */
  id: string;
  /** ID of the {@link CronJob} that triggered this alert. */
  jobId: string;
  /** Snapshot of the job's name at the time the alert was created. */
  jobName: string;
  /** Short summary of what happened. */
  message: string;
  /** ISO-8601 timestamp of when the alert was created. */
  timestamp: string;
  /** The prompt that was executed. */
  prompt: string;
  /** Full agent response text. */
  response: string;
  /** Whether the user has dismissed this alert. */
  acknowledged: boolean;
}
