import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from '../__tests__/temp-home.js';

/**
 * Deleting a cron job sweeps every store keyed by its id (#585).
 *
 * Real stores and a real filesystem throughout, deliberately: the bug was that
 * `deleteJob` is a pure `jobs.json` filter and every caller paired it with the
 * log store and nothing else, so a test that asserted "the row is gone" passed
 * for years while the workspace and the notes file stayed. Only "the directory
 * is not on disk" can fail on that.
 *
 * `cron/cli.test.ts` mocks both stores, which is right for its own subject and
 * is why the sweep is asserted here instead.
 */
useTempHome('bernard-cron-lifecycle');

let m: {
  deleteCronJob: typeof import('./lifecycle.js').deleteCronJob;
  CronStore: typeof import('./store.js').CronStore;
  CronLogStore: typeof import('./log-store.js').CronLogStore;
  CronNotesStore: typeof import('./notes-store.js').CronNotesStore;
  runWorkspace: typeof import('../paths.js').runWorkspace;
};

beforeEach(async () => {
  vi.resetModules();
  m = {
    deleteCronJob: (await import('./lifecycle.js')).deleteCronJob,
    CronStore: (await import('./store.js')).CronStore,
    CronLogStore: (await import('./log-store.js')).CronLogStore,
    CronNotesStore: (await import('./notes-store.js')).CronNotesStore,
    runWorkspace: (await import('../paths.js')).runWorkspace,
  };
});

/** A job with a log entry, a note and a workspace holding output. */
function seedJob(name = 'Nightly') {
  const store = new m.CronStore();
  const logStore = new m.CronLogStore();
  const job = store.createJob(name, '0 3 * * *', 'do the thing');

  logStore.appendEntry({
    runId: 'r1',
    jobId: job.id,
    jobName: job.name,
    prompt: job.prompt,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 1,
    success: true,
    finalOutput: 'done',
    steps: [],
    totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
  new m.CronNotesStore().append(job.id, 'found the reply on run 1');

  const workspace = m.runWorkspace('cron', job.id);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'report.md'), '# out');

  return { job, store, logStore, workspace };
}

describe('deleteCronJob', () => {
  it('removes the run workspace', () => {
    const { job, store, logStore, workspace } = seedJob();
    expect(fs.existsSync(workspace)).toBe(true);

    m.deleteCronJob(job.id, { store, logStore });

    expect(fs.existsSync(workspace)).toBe(false);
  });

  /**
   * `CronNotesStore.clear()` had no production caller at all before this — the
   * leak `apps/brief-store.ts` records as the precedent it deliberately did not
   * follow.
   */
  it('removes the notes file', () => {
    const { job, store, logStore } = seedJob();
    expect(new m.CronNotesStore().read(job.id).entries).toHaveLength(1);

    m.deleteCronJob(job.id, { store, logStore });

    expect(new m.CronNotesStore().read(job.id).entries).toEqual([]);
  });

  it('removes the row and the logs, as it always did', () => {
    const { job, store, logStore } = seedJob();

    expect(m.deleteCronJob(job.id, { store, logStore })).toBe(true);

    expect(store.getJob(job.id)).toBeUndefined();
    expect(logStore.getEntries(job.id, 10)).toEqual([]);
  });

  it('leaves another job entirely alone', () => {
    const a = seedJob('A');
    const b = seedJob('B');

    m.deleteCronJob(a.job.id, { store: a.store, logStore: a.logStore });

    expect(b.store.getJob(b.job.id)).toBeDefined();
    expect(fs.existsSync(b.workspace)).toBe(true);
    expect(new m.CronNotesStore().read(b.job.id).entries).toHaveLength(1);
  });

  /**
   * Every install that predates this has orphans from jobs whose rows are long
   * gone, so a sweep gated on the row could never reach them. Reporting `false`
   * is what the `cron` tool needs to say "no job found"; it is not a reason to
   * leave the artifacts.
   */
  it('reports a missing row and still sweeps the artifacts', () => {
    const { job, store, logStore, workspace } = seedJob();
    store.deleteJob(job.id); // the old, partial delete

    expect(m.deleteCronJob(job.id, { store, logStore })).toBe(false);

    expect(fs.existsSync(workspace)).toBe(false);
    expect(new m.CronNotesStore().read(job.id).entries).toEqual([]);
  });

  it('does not throw for an id the notes store refuses', () => {
    const store = new m.CronStore();
    const logStore = new m.CronLogStore();

    expect(() => m.deleteCronJob('///', { store, logStore })).not.toThrow();
  });
});
