import type { ToolErrorType } from '../framework/tools/types.js';

/** A recurring task that Bernard executes on a cron schedule. */
export interface CronJob {
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
