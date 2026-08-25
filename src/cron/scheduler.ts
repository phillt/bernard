import cron, { type ScheduledTask } from 'node-cron';
import { CronStore } from './store.js';
import { runJob, resolveCronJobTimeoutMs, type RunJobResult } from './runner.js';
import type { CronJob } from './types.js';

/**
 * Headroom the scheduler's slot-release backstop allows over a job's own wall
 * clock. The inner abort should always win — it stops the work and writes a
 * proper log entry and alert; this only fires when the hang is somewhere that
 * abort cannot reach.
 */
const SLOT_RELEASE_GRACE_MS = 60_000;

const DEFAULT_MAX_CONCURRENT = 3;

/**
 * Maps enabled cron jobs to `node-cron` scheduled tasks and manages concurrent execution.
 *
 * Maintains a bounded concurrency pool (configurable via `BERNARD_CRON_MAX_CONCURRENT`)
 * and a FIFO overflow queue so that jobs triggered while the pool is full are not dropped.
 */
export class Scheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private store: CronStore;
  private log: (msg: string) => void;
  private maxConcurrent: number;
  private runningCount = 0;
  private queue: CronJob[] = [];

  /**
   * @param store - Job persistence store used for loading jobs and recording run results.
   * @param log - Daemon-level logger callback.
   */
  constructor(store: CronStore, log: (msg: string) => void) {
    this.store = store;
    this.log = log;
    this.maxConcurrent =
      parseInt(process.env.BERNARD_CRON_MAX_CONCURRENT || '', 10) || DEFAULT_MAX_CONCURRENT;
  }

  /** Syncs scheduled tasks with the current jobs on disk: stops removed/disabled jobs and starts new/re-enabled ones. */
  reconcile(): void {
    const jobs = this.store.loadJobs();
    const jobMap = new Map(jobs.map((j) => [j.id, j]));

    // Stop tasks for removed or disabled jobs
    for (const [id, task] of this.tasks) {
      const job = jobMap.get(id);
      if (!job?.enabled) {
        this.log(`Stopping task for job "${id}"`);
        void task.stop();
        this.tasks.delete(id);
      }
    }

    // Start tasks for new or re-enabled jobs
    for (const job of jobs) {
      if (!job.enabled) continue;
      if (this.tasks.has(job.id)) continue;

      if (!cron.validate(job.schedule)) {
        this.log(`Invalid cron expression for job "${job.name}" (${job.id}): ${job.schedule}`);
        continue;
      }

      this.log(`Scheduling job "${job.name}" (${job.id}): ${job.schedule}`);
      const task = cron.schedule(job.schedule, () => {
        this.enqueueRun(job);
      });
      this.tasks.set(job.id, task);
    }
  }

  /** Queues a job for execution, running it immediately if the concurrency pool has capacity. */
  private enqueueRun(job: CronJob): void {
    if (this.runningCount >= this.maxConcurrent) {
      this.log(`Job "${job.name}" queued (${this.runningCount}/${this.maxConcurrent} running)`);
      this.queue.push(job);
      return;
    }
    void this.executeJob(job);
  }

  /** Runs a job via `runJob`, updates its status in the store, and drains the queue on completion. */
  private async executeJob(job: CronJob): Promise<void> {
    this.runningCount++;
    const startTime = new Date().toISOString();
    this.log(`Running job "${job.name}" (${job.id}) at ${startTime}`);

    this.store.updateJob(job.id, {
      lastRun: startTime,
      lastRunStatus: 'running',
    });

    // Re-read the job from disk at execution time so that any edits made
    // between reconcile() and now (e.g. confirmMode / toolMode / skipPermissions
    // updates, #260) take effect on the next fire without a daemon restart.
    // Fall back to the captured snapshot if the job was deleted between enqueue
    // and execution (rare race; running with stale data is better than crashing).
    const currentJob = this.store.getJob(job.id) ?? job;

    try {
      const result = await this.runJobBounded(currentJob);
      this.store.updateJob(job.id, {
        lastRunStatus: result.success ? 'success' : 'error',
        lastResult: result.output.slice(0, 2000), // Truncate to avoid huge JSON
      });
      this.log(`Job "${job.name}" finished: ${result.success ? 'success' : 'error'}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.updateJob(job.id, {
        lastRunStatus: 'error',
        lastResult: message.slice(0, 2000),
      });
      this.log(`Job "${job.name}" threw: ${message}`);
    } finally {
      this.runningCount--;
      this.drainQueue();
    }
  }

  /**
   * Races `runJob` against the job's own wall clock so the slot is released
   * even when the hang is somewhere `runJob`'s internal abort cannot reach.
   *
   * The two layers answer different questions and both are needed (#326).
   * `runJob`'s `AbortSignal` stops the *work* — but it only covers the region
   * it wraps: the timer starts after `mcpManager.connect()` and the pre-run
   * RAG search, and `mcpManager.close()` runs in a `finally` after the timer
   * is cleared. A stdio child that ignores SIGTERM, or a slow embedding
   * search, hangs outside it. This race guarantees the *slot* is freed
   * regardless, which is the invariant the scheduler owns and the one whose
   * absence wedges every later fire: `drainQueue` runs only from a completing
   * job's `finally`, so a slot that is never released is a queue that never
   * drains.
   *
   * Deliberately generous over the job's own budget, so the inner abort is
   * what normally fires — it stops the work and writes a proper log entry and
   * alert. This is the backstop, and reaching it means something outside the
   * agent loop hung.
   */
  private async runJobBounded(job: CronJob): Promise<RunJobResult> {
    const budget = resolveCronJobTimeoutMs(job);
    const run = runJob(job, this.log);
    if (budget === null) return run;
    const grace = budget + SLOT_RELEASE_GRACE_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        run,
        new Promise<RunJobResult>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                success: false,
                output: `Error: job did not return ${grace} ms after starting; releasing its scheduler slot. The run may still be in flight.`,
              }),
            grace,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Dequeues and executes waiting jobs until the concurrency pool is full or the queue is empty. */
  private drainQueue(): void {
    while (this.queue.length > 0 && this.runningCount < this.maxConcurrent) {
      const next = this.queue.shift()!;
      void this.executeJob(next);
    }
  }

  /** Stops all scheduled tasks. Does not abort in-progress job executions. */
  stopAll(): void {
    for (const [id, task] of this.tasks) {
      void task.stop();
      this.tasks.delete(id);
    }
  }

  /** Number of currently scheduled (not necessarily running) cron tasks. */
  get activeCount(): number {
    return this.tasks.size;
  }
}
