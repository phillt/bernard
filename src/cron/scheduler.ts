import cron, { type ScheduledTask } from 'node-cron';
import { CronStore } from './store.js';
import { runJob } from './runner.js';
import type { CronJob } from './types.js';

const DEFAULT_MAX_CONCURRENT = 3;

export class Scheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private store: CronStore;
  private log: (msg: string) => void;
  private maxConcurrent: number;
  private runningCount = 0;
  private queue: CronJob[] = [];

  constructor(store: CronStore, log: (msg: string) => void) {
    this.store = store;
    this.log = log;
    this.maxConcurrent =
      parseInt(process.env.BERNARD_CRON_MAX_CONCURRENT || '', 10) || DEFAULT_MAX_CONCURRENT;
  }

  reconcile(): void {
    const jobs = this.store.loadJobs();
    const jobMap = new Map(jobs.map((j) => [j.id, j]));

    // Stop tasks for removed or disabled jobs
    for (const [id, task] of this.tasks) {
      const job = jobMap.get(id);
      if (!job || !job.enabled) {
        this.log(`Stopping task for job "${id}"`);
        task.stop();
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

  private enqueueRun(job: CronJob): void {
    if (this.runningCount >= this.maxConcurrent) {
      this.log(`Job "${job.name}" queued (${this.runningCount}/${this.maxConcurrent} running)`);
      this.queue.push(job);
      return;
    }
    this.executeJob(job);
  }

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

  private drainQueue(): void {
    while (this.queue.length > 0 && this.runningCount < this.maxConcurrent) {
      const next = this.queue.shift()!;
      this.executeJob(next);
    }
  }

  stopAll(): void {
    for (const [id, task] of this.tasks) {
      task.stop();
      this.tasks.delete(id);
    }
  }

  get activeCount(): number {
    return this.tasks.size;
  }
}
