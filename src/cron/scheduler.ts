import cron, { type ScheduledTask } from 'node-cron';
import { CronStore } from './store.js';
import { runJob } from './runner.js';
import type { CronJob } from './types.js';

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

    try {
      const result = await runJob(job, this.log);
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
