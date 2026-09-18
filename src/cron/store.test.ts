import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';

/**
 * `CronStore` had no test of its own, and the fields #400 adds are exactly the
 * kind that fail silently: the scheduler writes them, nothing reads them back
 * in the same process, and a round trip that dropped one would surface months
 * later as "cron stopped catching up" with nothing pointing here.
 *
 * Real filesystem, because the whole question is whether the record survives
 * being written and parsed again.
 */
useTempHome('bernard-cron-store');

let CronStore: typeof import('./store.js').CronStore;

beforeEach(async () => {
  vi.resetModules();
  ({ CronStore } = await import('./store.js'));
});

describe('CronStore', () => {
  it('round-trips the scheduling fields a job can be created with', () => {
    const store = new CronStore();
    const created = store.createJob('Monitor', '0 */2 * * *', 'check replies', {
      catchUp: true,
      toolMode: 'read-only',
    });
    expect(created.catchUp).toBe(true);

    const read = new CronStore().getJob(created.id);
    expect(read?.catchUp).toBe(true);
    expect(read?.toolMode).toBe('read-only');
  });

  it('leaves an unset option off the record rather than writing a false', () => {
    // `catchUp` unset means "the behaviour every existing job was created
    // under". Writing `false` would be a decision nobody made.
    const store = new CronStore();
    const created = store.createJob('Plain', '0 0 * * *', 'do the thing');
    expect('catchUp' in created).toBe(false);
    expect(store.getJob(created.id)).not.toHaveProperty('catchUp');
  });

  it('persists the scheduler bookkeeping the tick writes on every fire', () => {
    // The old `updateJob` took a hand-written union of field names, so a field
    // added to the record and not to that list simply could not be written.
    // Derived from `CronJob` now, which is what makes this assertion about
    // behaviour rather than about a list.
    const store = new CronStore();
    const job = store.createJob('Monitor', '0 */2 * * *', 'check replies');

    store.updateJob(job.id, {
      nextRunAt: '2026-06-15T12:00:00.000Z',
      missedRuns: 4,
      lastMissedAt: '2026-06-15T11:30:00.000Z',
      catchUp: true,
    });

    const read = new CronStore().getJob(job.id);
    expect(read).toMatchObject({
      nextRunAt: '2026-06-15T12:00:00.000Z',
      missedRuns: 4,
      lastMissedAt: '2026-06-15T11:30:00.000Z',
      catchUp: true,
    });
  });

  it('refuses to create past its ceiling', () => {
    const store = new CronStore();
    const jobs = Array.from({ length: 50 }, (_, i) => ({
      id: `j${i}`,
      name: `J${i}`,
      schedule: '0 0 * * *',
      prompt: 'p',
      enabled: true,
      createdAt: 'now',
    }));
    store.saveJobs(jobs);
    expect(() => store.createJob('One more', '0 0 * * *', 'p')).toThrow(/Maximum of 50/);
  });
});
