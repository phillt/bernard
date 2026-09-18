import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CronJob } from './types.js';

const mockStore = vi.hoisted(() => ({
  loadJobs: vi.fn(() => [] as CronJob[]),
  getJob: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  saveJobs: vi.fn(),
  listAlerts: vi.fn(() => []),
}));

const mockLogStore = vi.hoisted(() => ({
  getEntries: vi.fn(() => [] as Array<{ success: boolean }>),
  deleteJobLogs: vi.fn(),
}));

vi.mock('./store.js', () => ({ CronStore: vi.fn(() => mockStore) }));
vi.mock('./log-store.js', () => ({ CronLogStore: vi.fn(() => mockLogStore) }));
vi.mock('./client.js', () => ({
  isDaemonRunning: vi.fn(() => true),
  startDaemon: vi.fn(() => true),
  stopDaemon: vi.fn(() => true),
}));

const printed = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../output.js', () => ({
  printInfo: (msg: string) => printed.lines.push(msg),
  printError: (msg: string) => printed.lines.push(msg),
}));

import {
  FAILURE_STREAK_N,
  JOB_COUNT_WARN_AT,
  JOB_SIGNAL_IDS,
  duplicateJob,
  failureStreak,
  jobCountNotice,
  jobSignals,
  type JobSignalId,
} from './health.js';
import { cronList } from './cli.js';
import { createCronTool } from '../tools/cron.js';

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    name: 'Nightly',
    schedule: '0 0 * * *',
    prompt: 'do the thing',
    enabled: true,
    createdAt: '2026-06-12T00:00:00.000Z',
    ...overrides,
  };
}

const failures = (n: number) => Array.from({ length: n }, () => ({ success: false }));

beforeEach(() => {
  vi.clearAllMocks();
  printed.lines = [];
  mockStore.loadJobs.mockReturnValue([]);
  mockLogStore.getEntries.mockReturnValue([]);
});

describe('failureStreak', () => {
  it('opens nothing when the last run did not fail', () => {
    // The short-circuit is what keeps a 43-job listing from reading 43 whole
    // JSONL files to answer a question that is zero for all but the broken ones.
    expect(failureStreak(job({ lastRunStatus: 'success' }), mockLogStore)).toBe(0);
    expect(failureStreak(job(), mockLogStore)).toBe(0);
    expect(mockLogStore.getEntries).not.toHaveBeenCalled();
  });

  it('counts consecutive failures at the head of the log', () => {
    mockLogStore.getEntries.mockReturnValue(failures(3));
    expect(failureStreak(job({ lastRunStatus: 'error' }), mockLogStore)).toBe(3);
  });

  it('stops at the first success, so an old failure does not extend a new streak', () => {
    mockLogStore.getEntries.mockReturnValue([
      { success: false },
      { success: true },
      { success: false },
    ]);
    expect(failureStreak(job({ lastRunStatus: 'error' }), mockLogStore)).toBe(1);
  });

  it('reports fewer than the threshold when fewer runs have happened', () => {
    mockLogStore.getEntries.mockReturnValue(failures(2));
    const streak = failureStreak(job({ lastRunStatus: 'error' }), mockLogStore);
    expect(streak).toBe(2);
    expect(jobSignals({ job: job({ lastRunStatus: 'error' }), failureStreak: streak })).toEqual([]);
  });
});

describe('jobSignals', () => {
  it('says nothing about a healthy job', () => {
    expect(jobSignals({ job: job({ lastRunStatus: 'success' }), failureStreak: 0 })).toEqual([]);
  });

  it('carries both a label and the action that clears it', () => {
    const [signal] = jobSignals({ job: job(), failureStreak: FAILURE_STREAK_N });
    expect(signal.id).toBe('failing');
    expect(signal.label).toContain(`last ${FAILURE_STREAK_N} runs`);
    expect(signal.remedy).toContain('cron-stop job-1');
  });

  it('tells a job that already catches up something different from one that does not', () => {
    const on = jobSignals({ job: job({ missedRuns: 4, catchUp: true }), failureStreak: 0 });
    const off = jobSignals({ job: job({ missedRuns: 4 }), failureStreak: 0 });
    expect(on[0].remedy).toContain('catch-up is on');
    expect(off[0].remedy).toContain('set catchUp');
  });
});

describe('duplicateJob', () => {
  const existing = job({ id: 'old' });

  it('matches on schedule and prompt, ignoring the name', () => {
    expect(duplicateJob([existing], '0 0 * * *', 'do the thing')?.id).toBe('old');
  });

  it('sees through the whitespace cron.validate tolerates', () => {
    expect(duplicateJob([existing], ' 0  0 * * * ', ' do the thing ')?.id).toBe('old');
  });

  it('does not match a different schedule or a different prompt', () => {
    expect(duplicateJob([existing], '0 1 * * *', 'do the thing')).toBeUndefined();
    expect(duplicateJob([existing], '0 0 * * *', 'do something else')).toBeUndefined();
  });

  it('prefers an enabled twin, because the two deserve different answers', () => {
    const jobs = [job({ id: 'off', enabled: false }), job({ id: 'on' })];
    expect(duplicateJob(jobs, '0 0 * * *', 'do the thing')?.id).toBe('on');
    expect(duplicateJob([jobs[0]], '0 0 * * *', 'do the thing')?.id).toBe('off');
  });
});

describe('jobCountNotice', () => {
  it('says nothing below the threshold', () => {
    expect(jobCountNotice(JOB_COUNT_WARN_AT - 1, JOB_COUNT_WARN_AT - 1)).toBeNull();
  });

  it('names both numbers and the command that prunes', () => {
    const notice = jobCountNotice(43, 43);
    expect(notice).toContain('43 cron jobs');
    expect(notice).toContain('43 enabled');
    expect(notice).toContain('cron-delete');
  });
});

/**
 * Walks the signal table to the surfaces that render it.
 *
 * A job's health is printed by the CLI listing and by the `cron` tool's `list`
 * and `get`. Adding a signal and forgetting one of them is silent — the surface
 * simply keeps saying nothing is wrong — so the check is that every declared id
 * really reaches every surface, driven from the table rather than from a list
 * written out here.
 */
describe('every declared signal reaches every surface', () => {
  const FIXTURES: Record<JobSignalId, { job: CronJob; logEntries: Array<{ success: boolean }> }> = {
    failing: {
      job: job({ lastRunStatus: 'error' }),
      logEntries: failures(FAILURE_STREAK_N),
    },
    missed: {
      job: job({ missedRuns: 4, lastMissedAt: '2026-08-31T05:00:00.000Z' }),
      logEntries: [],
    },
  };

  it('declares a fixture for each id and no more', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...JOB_SIGNAL_IDS].sort());
  });

  it.each(JOB_SIGNAL_IDS)('%s', async (id) => {
    const fixture = FIXTURES[id];
    mockStore.loadJobs.mockReturnValue([fixture.job]);
    mockStore.getJob.mockReturnValue(fixture.job);
    mockLogStore.getEntries.mockReturnValue(fixture.logEntries);

    const [signal] = jobSignals({
      job: fixture.job,
      failureStreak: failureStreak(fixture.job, mockLogStore),
    });
    expect(signal?.id).toBe(id);

    await cronList();
    expect(printed.lines.join('\n')).toContain(signal.label);

    const tools = createCronTool();
    const exec = (args: Record<string, unknown>) =>
      (tools.cron as unknown as { execute: (a: unknown, b: unknown) => Promise<string> }).execute(
        args,
        {},
      );
    expect(await exec({ action: 'list' })).toContain(signal.label);
    expect(await exec({ action: 'get', id: fixture.job.id })).toContain(signal.label);
    expect(await exec({ action: 'status' })).toContain('Jobs needing attention: 1');
  });
});
