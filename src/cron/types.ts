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
