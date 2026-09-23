import cron from 'node-cron';
import { CronStore } from './store.js';
import { runJob, resolveCronJobTimeoutMs, type RunJobResult } from './runner.js';
import {
  countBoundaries,
  matchesAt,
  nextMatchAfter,
  parseCronFields,
  type CronFields,
} from './schedule-clock.js';
import { formatElapsed } from '../output.js';
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
 * The longest the scheduler will ever wait between checks, and the fix for #400.
 *
 * node-cron arms one timer per task straight to the next matching instant —
 * measured at 3,360,246 ms for an hourly job. Node timers run on
 * `CLOCK_MONOTONIC`, which does not advance while a Linux machine is suspended,
 * so a timer armed before a sleep fires that many milliseconds of *awake* time
 * later. On the machine that filed #400 the clock lost 55 of 71 hours that way
 * and a two-hourly job ran twice in 24 hours, with nothing anywhere recording
 * that eleven fires had been dropped.
 *
 * Capping the wait repairs it on every platform at once, because it repairs the
 * *wait* rather than the clock: whatever the operating system did to the
 * process, the next check is at most this far away in awake time, and the
 * decision it then makes is re-derived from `Date.now()` against a persisted
 * boundary rather than from a timer that was supposed to have expired. macOS and
 * Windows count sleep in their monotonic clocks, so they fire promptly-but-late
 * rather than drifting; the same cap bounds both.
 *
 * The wait is `min(this, time until the earliest boundary)`, so a
 * seconds-granularity expression is still honoured exactly and an idle daemon
 * still wakes only twice a minute.
 *
 * It doubles as the lateness threshold in {@link Scheduler.fireDue}, which has
 * one consequence worth knowing: for a schedule whose period is at or below
 * this, the threshold equals the job's own period, so such a job is never
 * classified late and never reports a miss. That is the right answer anyway —
 * a job due every ten seconds has no useful notion of a fire worth catching up
 * — but it means the miss reporting is meaningfully about minute-granularity
 * schedules and coarser.
 */
const MAX_TICK_WAIT_MS = 30_000;

/**
 * How many boundaries one miss report will walk before it says "or more".
 *
 * A fortnight of a shut laptop against a one-minute schedule is 20,160
 * boundaries, and the only consumer of the number is a count on a list row.
 */
const MISS_COUNT_CAP = 500;

/** A job the scheduler is holding, with its expression parsed once. */
interface ScheduledJob {
  job: CronJob;
  fields: CronFields;
  /** Epoch ms of the boundary this job is waiting for. */
  dueAt: number;
}

/**
 * Drives enabled cron jobs off the wall clock and manages concurrent execution.
 *
 * Maintains a bounded concurrency pool (configurable via `BERNARD_CRON_MAX_CONCURRENT`)
 * and a FIFO overflow queue so that jobs triggered while the pool is full are not dropped.
 *
 * **It no longer calls `cron.schedule`.** node-cron is still the gate on which
 * expressions are accepted — `cron.validate`, unchanged, at every write — but
 * firing is one self-rescheduling timer capped at {@link MAX_TICK_WAIT_MS},
 * against boundaries computed by `schedule-clock.ts`. See that constant for why.
 */
export class Scheduler {
  private scheduled: Map<string, ScheduledJob> = new Map();
  private store: CronStore;
  private log: (msg: string) => void;
  private maxConcurrent: number;
  private runningCount = 0;
  private queue: CronJob[] = [];
  private tickTimer: NodeJS.Timeout | undefined;
  private stopped = false;

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

  /**
   * Syncs held jobs with the current jobs on disk: drops removed and disabled
   * ones, picks up new and re-enabled ones, and arms the tick if it is not
   * already running.
   *
   * Arming here rather than behind a separate `start()` keeps `daemon.ts`
   * untouched: it already calls this once at boot and again on every `jobs.json`
   * change, which is exactly the set of moments the scheduler learns anything.
   */
  reconcile(): void {
    const jobs = this.store.loadJobs();
    const jobMap = new Map(jobs.map((j) => [j.id, j]));

    for (const [id, held] of this.scheduled) {
      const job = jobMap.get(id);
      if (!job?.enabled) {
        this.log(`Stopping task for job "${id}"`);
        this.scheduled.delete(id);
        continue;
      }
      // A schedule edited in place used to take effect only after a daemon
      // restart or a `cron-bounce`, because the old reconcile skipped any job it
      // already held. With the boundary persisted in `nextRunAt` the stale one
      // would now survive restarts too, so it has to be noticed here.
      if (held.job.schedule !== job.schedule) {
        const seeded = this.seed(job, { fresh: true });
        if (!seeded) {
          this.scheduled.delete(id);
          continue;
        }
        this.log(`Rescheduling job "${job.name}" (${job.id}): ${job.schedule}`);
        held.fields = seeded.fields;
        held.dueAt = seeded.dueAt;
      }
      // Refresh the record either way, so `catchUp` and posture edits apply on
      // the next fire without the job being disabled and re-enabled first.
      held.job = job;
    }

    for (const job of jobs) {
      if (!job.enabled) continue;
      if (this.scheduled.has(job.id)) continue;
      const seeded = this.seed(job, { fresh: false });
      if (!seeded) continue;
      this.log(`Scheduling job "${job.name}" (${job.id}): ${job.schedule}`);
      this.scheduled.set(job.id, { job, ...seeded });
    }

    this.armTick();
  }

  /**
   * Parses a job's expression and settles the boundary it is waiting for,
   * persisting that boundary when it is newly chosen.
   *
   * `fresh` is the difference between picking a job up and re-seeding one whose
   * schedule just changed. Picking one up prefers the boundary already on disk —
   * that is what makes a stopped daemon, or a machine that was off, a missed
   * fire rather than a silent re-seed from "now". A changed schedule must
   * discard it, because it was computed from an expression that no longer
   * exists.
   */
  private seed(
    job: CronJob,
    opts: { fresh: boolean },
  ): { fields: CronFields; dueAt: number } | null {
    // `cron.validate` stays first so the message for a typo is the one users
    // have always seen. The second check is a different question: validate says
    // the expression is well formed, this says the scheduler can enumerate its
    // boundaries — and a job that passes one and fails the other must not be
    // held in a state where it looks scheduled.
    if (!cron.validate(job.schedule)) {
      this.log(`Invalid cron expression for job "${job.name}" (${job.id}): ${job.schedule}`);
      return null;
    }
    const fields = parseCronFields(job.schedule);
    if (!fields) {
      this.log(
        `Cannot expand cron expression for job "${job.name}" (${job.id}): ${job.schedule}. ` +
          'It will not be scheduled.',
      );
      return null;
    }

    const persisted = opts.fresh ? NaN : Date.parse(job.nextRunAt ?? '');
    if (!Number.isNaN(persisted)) {
      // A boundary is only ever written by this file, and only ever from
      // `nextMatchAfter` — so one that does not match the current expression
      // was computed from a different one. `CronStore.updateJob` clears it on
      // every schedule change made through Bernard, which covers every code
      // path; this catches the one it cannot, a `jobs.json` edited by hand
      // while the daemon was down. It answers exactly the question that
      // matters — "was this boundary computed from THIS expression" — where
      // comparing it against `nextMatchAfter(now)` could not tell a stale
      // boundary from a legitimately distant one.
      if (matchesAt(fields, new Date(persisted))) return { fields, dueAt: persisted };
      this.log(
        `Job "${job.name}" (${job.id}) had a stored next run (${job.nextRunAt}) that its ` +
          `schedule (${job.schedule}) does not match — recomputing.`,
      );
    }

    const next = nextMatchAfter(fields, new Date());
    if (!next) {
      this.log(`Job "${job.name}" (${job.id}) has no upcoming run for: ${job.schedule}`);
      return null;
    }
    this.store.updateJob(job.id, { nextRunAt: next.toISOString() });
    return { fields, dueAt: next.getTime() };
  }

  /** Arms the next check at `min(MAX_TICK_WAIT_MS, time until the earliest boundary)`. */
  private armTick(): void {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    const now = Date.now();
    let soonest = now + MAX_TICK_WAIT_MS;
    for (const held of this.scheduled.values()) {
      if (held.dueAt < soonest) soonest = held.dueAt;
    }
    this.tickTimer = setTimeout(() => this.tick(), Math.max(0, soonest - now));
  }

  /**
   * Fires every job whose boundary has passed, once each, and re-arms.
   *
   * Never throws: this is the daemon's heartbeat, and an exception escaping it
   * would silently stop every job on the machine.
   */
  private tick(): void {
    try {
      const now = Date.now();
      for (const held of this.scheduled.values()) {
        if (held.dueAt > now) continue;
        this.fireDue(held, now);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Scheduler tick failed: ${message}`);
    } finally {
      this.armTick();
    }
  }

  /**
   * Decides what one overdue job owes, advances its boundary, and enqueues it.
   *
   * **Lateness decides whether to run, not the missed count.** A daily job slept
   * through for eight hours has *no* boundary between its due time and now, so a
   * count-based test would call it on time and fire it as though nothing had
   * happened. One full tick is the threshold because that is the only guarantee
   * the loop gives: it checks at least that often, so anything later than that
   * means the process was not running when it should have been.
   *
   * **The next boundary is computed from `now`, not from the one that was
   * missed.** That is the coalescing: everything in between is passed over in
   * one step rather than replayed, so a weekend of misses costs one run for a
   * catch-up job and none for anything else. Replaying them would be sixty
   * passes over the same inbox against a pool of three, to reach the answer the
   * first one already gives.
   */
  private fireDue(held: ScheduledJob, now: number): void {
    const { job, fields } = held;
    const due = new Date(held.dueAt);
    const lateBy = now - held.dueAt;
    const late = lateBy > MAX_TICK_WAIT_MS;

    const boundaries = countBoundaries(fields, due, new Date(now), MISS_COUNT_CAP);
    const willRun = !late || job.catchUp === true;
    // Every boundary that passes without a run is a miss; the one about to run
    // is not.
    const missedNow = Math.max(0, boundaries.count - (willRun ? 1 : 0));

    const next = nextMatchAfter(fields, new Date(now));
    if (next) {
      held.dueAt = next.getTime();
    } else {
      // Unreachable for anything `seed` accepted — it already found one match,
      // and a cron expression that matches once matches forever. Dropped rather
      // than left holding a boundary in the past, which would re-fire on every
      // tick for the life of the daemon.
      this.log(`Job "${job.name}" (${job.id}) has no further run for: ${job.schedule}`);
      this.scheduled.delete(job.id);
    }

    // An on-time run clears the count, so it answers "how much has this job
    // dropped lately" rather than "since it was created" — the first is
    // actionable, the second is a number nobody can do anything with.
    let missedRuns = job.missedRuns ?? 0;
    if (missedNow > 0) missedRuns += missedNow;
    else if (!late) missedRuns = 0;
    job.missedRuns = missedRuns;
    this.store.updateJob(job.id, {
      ...(next ? { nextRunAt: next.toISOString() } : {}),
      missedRuns,
      ...(missedNow > 0 ? { lastMissedAt: new Date(now).toISOString() } : {}),
    });

    if (missedNow > 0) {
      const count = boundaries.capped ? `${boundaries.count}+` : String(boundaries.count);
      this.log(
        `Job "${job.name}" (${job.id}) was due ${formatElapsed(lateBy)} ago at ` +
          `${due.toISOString()} — ${count} fire(s) missed while the daemon was not running ` +
          '(asleep, stopped, or the machine was off). ' +
          (willRun
            ? 'Running one of them now (catchUp is on).'
            : 'Skipping them; set catchUp on this job to run one on wake.'),
      );
    }

    if (willRun) this.enqueueRun(job);
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

  /** Stops the tick and drops every held job. Does not abort in-progress job executions. */
  stopAll(): void {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = undefined;
    this.scheduled.clear();
  }

  /** Number of currently scheduled (not necessarily running) cron jobs. */
  /**
   * Jobs executing right now, as opposed to {@link activeCount}, which counts
   * jobs SCHEDULED. Read by the daemon before it replaces itself after a
   * rebuild — see `src/build-stamp.ts` for why it has to.
   */
  get inFlightCount(): number {
    return this.runningCount;
  }

  get activeCount(): number {
    return this.scheduled.size;
  }
}
