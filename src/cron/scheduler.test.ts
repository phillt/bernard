import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CronJob } from './types.js';

const mockRunJob = vi.hoisted(() => vi.fn());
const mockTimeout = vi.hoisted(() => vi.fn(() => null as number | null));

vi.mock('./runner.js', () => ({
  runJob: mockRunJob,
  resolveCronJobTimeoutMs: mockTimeout,
}));

import { Scheduler } from './scheduler.js';
import { CronStore } from './store.js';

/**
 * These tests drive the scheduler's own clock, not an operating system.
 *
 * The bug in #400 is that Node's timers run on a clock that does not advance
 * while a Linux machine is suspended, so a timer armed for two hours fires two
 * hours of *awake* time later. No test can suspend a machine, and this one does
 * not pretend to: `vi.setSystemTime` moves the wall clock forward WITHOUT
 * advancing the fake timers, which reproduces exactly the divergence the bug is
 * made of — `Date.now()` has jumped, the armed timer has not expired — and then
 * one ordinary tick is delivered, standing in for the resume. What is asserted
 * is therefore the wrapper: given a clock that jumped, does the scheduler notice,
 * count, record and coalesce correctly. What is NOT asserted is libuv's timer
 * behaviour across a real suspend, which is the premise rather than the change.
 */

/** Local-time constructor, so nothing here depends on the runner's zone. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date =>
  new Date(y, mo - 1, d, h, mi, s, 0);

/**
 * Restated rather than imported, deliberately: this is the bound the fix rests
 * on, and importing it would make the assertion self-consistent with whatever
 * the constant happens to say. Widening the real one has to fail here.
 */
const MAX_TICK_WAIT_MS = 30_000;

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    name: 'Monitor',
    schedule: '0 */2 * * *',
    prompt: 'check the replies',
    enabled: true,
    createdAt: at(2026, 6, 1).toISOString(),
    ...overrides,
  };
}

/**
 * An in-memory stand-in for `CronStore`: the three methods the scheduler uses.
 *
 * Reads hand back copies, because the real store parses `jobs.json` afresh every
 * time and the scheduler compares the record it is holding against the one on
 * disk. A double that returned the same objects would make every such comparison
 * trivially equal, and the schedule-change branch would never be exercised.
 */
function makeStore(jobs: CronJob[]) {
  return {
    jobs,
    loadJobs: () => jobs.map((j) => ({ ...j })),
    getJob: (id: string) => {
      const job = jobs.find((j) => j.id === id);
      return job ? { ...job } : undefined;
    },
    updateJob: vi.fn((id: string, updates: Partial<CronJob>) => {
      const job = jobs.find((j) => j.id === id);
      if (!job) return undefined;
      Object.assign(job, updates);
      return job;
    }),
  };
}

type TestStore = ReturnType<typeof makeStore>;

function makeScheduler(store: TestStore) {
  const lines: string[] = [];
  const scheduler = new Scheduler(store as unknown as CronStore, (msg) => lines.push(msg));
  return { scheduler, lines };
}

describe('Scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunJob.mockResolvedValue({ success: true, output: 'ok' });
    mockTimeout.mockReturnValue(null);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the ordinary path', () => {
    it('fires on the boundary and records the next one', async () => {
      vi.setSystemTime(at(2026, 6, 15, 3, 59, 0));
      const store = makeStore([makeJob()]);
      const { scheduler } = makeScheduler(store);
      scheduler.reconcile();
      expect(store.jobs[0].nextRunAt).toBe(at(2026, 6, 15, 4, 0).toISOString());

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockRunJob).toHaveBeenCalledTimes(1);
      expect(store.jobs[0].nextRunAt).toBe(at(2026, 6, 15, 6, 0).toISOString());
      scheduler.stopAll();
    });

    it('never arms a wait longer than one tick, however far away the boundary is', async () => {
      // The whole of #400 in one assertion. node-cron armed 3,360,246 ms for an
      // hourly job; a wait that long is what a suspend eats.
      vi.setSystemTime(at(2026, 6, 15, 4, 0, 1));
      const store = makeStore([makeJob({ schedule: '0 0 1 1 *' })]);
      const { scheduler } = makeScheduler(store);
      const delays: number[] = [];
      // Captured after `useFakeTimers`, so this is the fake the scheduler will
      // actually be driven by — the spy only records the delay on its way past.
      const armed = globalThis.setTimeout;
      const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        fn: () => void,
        ms?: number,
      ) => {
        delays.push(ms ?? 0);
        return armed(fn, ms);
      }) as never);

      scheduler.reconcile();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      spy.mockRestore();

      expect(delays.length).toBeGreaterThan(5);
      expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TICK_WAIT_MS);
      scheduler.stopAll();
    });

    it('clears a standing missed count once a run lands on time', async () => {
      vi.setSystemTime(at(2026, 6, 15, 3, 59, 0));
      const store = makeStore([makeJob({ missedRuns: 11, lastMissedAt: 'earlier' })]);
      const { scheduler } = makeScheduler(store);
      scheduler.reconcile();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockRunJob).toHaveBeenCalledTimes(1);
      expect(store.jobs[0].missedRuns).toBe(0);
      scheduler.stopAll();
    });
  });

  describe('when the wall clock jumps past boundaries the timers slept through', () => {
    /**
     * Arms the scheduler just before a boundary, then moves the wall clock
     * forward without letting the timers run — the shape of a suspend — and
     * delivers one tick.
     */
    async function sleepThrough(job: CronJob, jumpToward: Date) {
      vi.setSystemTime(at(2026, 6, 15, 3, 59, 0));
      const store = makeStore([job]);
      const { scheduler, lines } = makeScheduler(store);
      scheduler.reconcile();
      expect(store.jobs[0].nextRunAt).toBe(at(2026, 6, 15, 4, 0).toISOString());

      // `setSystemTime` moves the wall clock and leaves each timer its original
      // REMAINING delay, which is precisely what a suspend does to a monotonic
      // clock. So the pending tick still owes its full wait, and arrives one
      // tick-length after the resume — the bound the whole fix rests on.
      vi.setSystemTime(jumpToward);
      await vi.advanceTimersByTimeAsync(MAX_TICK_WAIT_MS);
      return { store, scheduler, lines };
    }

    it('drops every missed fire by default, and says so', async () => {
      // 04:00, 06:00, 08:00 and 10:00 all passed while the machine slept.
      const { store, lines, scheduler } = await sleepThrough(makeJob(), at(2026, 6, 15, 11, 30, 0));

      expect(mockRunJob).not.toHaveBeenCalled();
      expect(store.jobs[0].missedRuns).toBe(4);
      // Stamped at the moment the miss was noticed, not at the boundary.
      expect(store.jobs[0].lastMissedAt).toBe(new Date().toISOString());
      const missLine = lines.find((l) => l.includes('missed'));
      expect(missLine).toContain('4 fire(s) missed');
      expect(missLine).toContain('set catchUp');
      scheduler.stopAll();
    });

    it('runs exactly one of them when the job asked to catch up', async () => {
      const { store, lines, scheduler } = await sleepThrough(
        makeJob({ catchUp: true }),
        at(2026, 6, 15, 11, 30, 0),
      );

      // One run, not four: the state a monitor reports on is current state, and
      // replaying every boundary would be four passes over the same inbox.
      expect(mockRunJob).toHaveBeenCalledTimes(1);
      expect(store.jobs[0].missedRuns).toBe(3);
      expect(lines.find((l) => l.includes('missed'))).toContain('catchUp is on');
      scheduler.stopAll();
    });

    it('coalesces by advancing to the next boundary after now, never through the gap', async () => {
      const { store, scheduler } = await sleepThrough(
        makeJob({ catchUp: true }),
        at(2026, 6, 15, 11, 30, 0),
      );
      expect(store.jobs[0].nextRunAt).toBe(at(2026, 6, 15, 12, 0).toISOString());
      // And one run only — a second tick must not replay the gap.
      await vi.advanceTimersByTimeAsync(MAX_TICK_WAIT_MS);
      expect(mockRunJob).toHaveBeenCalledTimes(1);
      scheduler.stopAll();
    });

    it('counts a daily job as missed even though no extra boundary passed', async () => {
      // The count-based test would call this on time: between 04:00 and 11:30
      // a `0 4 * * *` job has exactly one boundary, its own. Lateness is what
      // decides, which is why the threshold is one tick and not one boundary.
      const { store, scheduler } = await sleepThrough(
        makeJob({ schedule: '0 4 * * *' }),
        at(2026, 6, 15, 11, 30, 0),
      );
      expect(mockRunJob).not.toHaveBeenCalled();
      expect(store.jobs[0].missedRuns).toBe(1);
      scheduler.stopAll();
    });

    it('reports "or more" rather than claiming a walked count it stopped short of', async () => {
      const { store, scheduler, lines } = await sleepThrough(
        makeJob({ schedule: '* * * * *' }),
        at(2026, 6, 25, 4, 0, 0),
      );
      expect(store.jobs[0].missedRuns).toBe(500);
      expect(lines.find((l) => l.includes('missed'))).toContain('500+ fire(s) missed');
      scheduler.stopAll();
    });
  });

  describe('picking a job back up', () => {
    it('treats a boundary persisted by a previous daemon as a missed fire', async () => {
      // A stopped daemon and a sleeping machine are the same failure: without
      // the persisted boundary this would re-seed from "now" and report nothing.
      vi.setSystemTime(at(2026, 6, 15, 11, 30, 0));
      const store = makeStore([
        makeJob({ nextRunAt: at(2026, 6, 15, 4, 0).toISOString(), catchUp: true }),
      ]);
      const { scheduler } = makeScheduler(store);
      scheduler.reconcile();
      await vi.advanceTimersByTimeAsync(1);

      expect(mockRunJob).toHaveBeenCalledTimes(1);
      expect(store.jobs[0].missedRuns).toBe(3);
      scheduler.stopAll();
    });

    it('discards a boundary computed from a schedule that has since changed', async () => {
      vi.setSystemTime(at(2026, 6, 15, 3, 59, 0));
      const store = makeStore([makeJob()]);
      const { scheduler, lines } = makeScheduler(store);
      scheduler.reconcile();
      expect(store.jobs[0].nextRunAt).toBe(at(2026, 6, 15, 4, 0).toISOString());

      // An in-place schedule edit used to take effect only after a restart.
      store.jobs[0].schedule = '0 5 * * *';
      scheduler.reconcile();
      expect(lines.some((l) => l.startsWith('Rescheduling job'))).toBe(true);
      expect(store.jobs[0].nextRunAt).toBe(at(2026, 6, 15, 5, 0).toISOString());
      scheduler.stopAll();
    });

    it('picks up a catchUp edit without the job being disabled and re-enabled', async () => {
      vi.setSystemTime(at(2026, 6, 15, 3, 59, 0));
      const store = makeStore([makeJob()]);
      const { scheduler } = makeScheduler(store);
      scheduler.reconcile();

      store.jobs[0].catchUp = true;
      scheduler.reconcile();

      vi.setSystemTime(at(2026, 6, 15, 11, 30, 0));
      await vi.advanceTimersByTimeAsync(MAX_TICK_WAIT_MS);
      expect(mockRunJob).toHaveBeenCalledTimes(1);
      scheduler.stopAll();
    });

    it('refuses an expression it cannot schedule instead of holding it silently', () => {
      vi.setSystemTime(at(2026, 6, 15, 4, 0));
      const store = makeStore([makeJob({ schedule: 'not a cron expression' })]);
      const { scheduler, lines } = makeScheduler(store);
      scheduler.reconcile();

      expect(scheduler.activeCount).toBe(0);
      expect(lines.some((l) => l.includes('Invalid cron expression'))).toBe(true);
      scheduler.stopAll();
    });

    it('drops a job that has been disabled', () => {
      vi.setSystemTime(at(2026, 6, 15, 3, 59));
      const store = makeStore([makeJob()]);
      const { scheduler } = makeScheduler(store);
      scheduler.reconcile();
      expect(scheduler.activeCount).toBe(1);

      store.jobs[0].enabled = false;
      scheduler.reconcile();
      expect(scheduler.activeCount).toBe(0);
      scheduler.stopAll();
    });
  });

  describe('a schedule edited while the scheduler was not holding the job', () => {
    /**
     * Real `CronStore`, because the whole question is what survives the round
     * trip through `jobs.json` — and because the invalidation being tested
     * lives in the store, so a double that re-implemented it would be asserting
     * against itself. `setup-test-home.ts` already points `BERNARD_HOME` at a
     * throwaway directory per test file.
     */
    function realStore(): CronStore {
      const store = new CronStore();
      store.saveJobs([]);
      return store;
    }

    it('does not inherit a boundary from the expression it replaced', async () => {
      // The path no other test shape reaches: the daemon is up throughout, so
      // `reconcile`'s schedule-change branch never runs — disabling removed the
      // job from the map, and it comes back through the "prefer what is on
      // disk" path. Before this, `nextRunAt` still named the old daily 03:00.
      vi.setSystemTime(at(2026, 6, 15, 1, 0, 0));
      const store = realStore();
      const created = store.createJob('Monitor', '0 3 * * *', 'check replies');
      const { scheduler, lines } = makeScheduler(store as unknown as TestStore);

      scheduler.reconcile();
      expect(store.getJob(created.id)?.nextRunAt).toBe(at(2026, 6, 15, 3, 0).toISOString());

      store.updateJob(created.id, { enabled: false });
      scheduler.reconcile();
      store.updateJob(created.id, { schedule: '0 * * * *' });
      store.updateJob(created.id, { enabled: true });
      scheduler.reconcile();

      expect(store.getJob(created.id)?.nextRunAt).toBe(at(2026, 6, 15, 2, 0).toISOString());

      // …and the run that follows is on time, with nothing claiming the daemon
      // was asleep. A fabricated miss report is worse than the silence it
      // replaces: it is the one a user would act on by turning catchUp on for a
      // job that never needed it.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(mockRunJob).toHaveBeenCalledTimes(1);
      expect(lines.some((l) => l.includes('missed'))).toBe(false);
      expect(store.getJob(created.id)?.missedRuns).toBe(0);
      scheduler.stopAll();
    });

    it('discards a hand-edited boundary the current expression cannot produce', async () => {
      // `jobs.json` is a file the daemon watches and users edit; an edit made
      // while the daemon was down never passes through `updateJob`, so the
      // store's invalidation cannot run. A boundary is only ever written from
      // `nextMatchAfter`, so one the expression does not match was computed
      // from a different expression.
      vi.setSystemTime(at(2026, 6, 15, 6, 0, 0));
      const store = realStore();
      const created = store.createJob('Monitor', '0 9 * * *', 'check replies');
      store.saveJobs(
        store.loadJobs().map((j) => ({ ...j, nextRunAt: at(2026, 6, 15, 2, 0).toISOString() })),
      );

      const { scheduler, lines } = makeScheduler(store as unknown as TestStore);
      scheduler.reconcile();

      expect(store.getJob(created.id)?.nextRunAt).toBe(at(2026, 6, 15, 9, 0).toISOString());
      expect(lines.some((l) => l.includes('does not match'))).toBe(true);

      await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
      expect(mockRunJob).toHaveBeenCalledTimes(1);
      expect(lines.some((l) => l.includes('missed'))).toBe(false);
      scheduler.stopAll();
    });

    it('keeps a stored boundary the expression does match', async () => {
      // The other direction, and the one that must not regress: a legitimately
      // distant boundary — a daemon restarted minutes after seeding — is what
      // makes a stopped daemon a missed fire rather than a silent re-seed.
      vi.setSystemTime(at(2026, 6, 15, 1, 0, 0));
      const store = realStore();
      const created = store.createJob('Monitor', '0 3 * * *', 'check replies');
      store.updateJob(created.id, { nextRunAt: at(2026, 6, 15, 3, 0).toISOString() });

      const { scheduler, lines } = makeScheduler(store as unknown as TestStore);
      scheduler.reconcile();

      expect(store.getJob(created.id)?.nextRunAt).toBe(at(2026, 6, 15, 3, 0).toISOString());
      expect(lines.some((l) => l.includes('does not match'))).toBe(false);
      scheduler.stopAll();
    });
  });

  it('stops ticking after stopAll', async () => {
    vi.setSystemTime(at(2026, 6, 15, 3, 59, 0));
    const store = makeStore([makeJob()]);
    const { scheduler } = makeScheduler(store);
    scheduler.reconcile();
    scheduler.stopAll();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(mockRunJob).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
