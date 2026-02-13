import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks ---

const mockStore = vi.hoisted(() => ({
  loadJobs: vi.fn().mockReturnValue([]),
  getJob: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  deleteJob: vi.fn(),
  saveJobs: vi.fn(),
  listAlerts: vi.fn().mockReturnValue([]),
}));

const mockClient = vi.hoisted(() => ({
  isDaemonRunning: vi.fn().mockReturnValue(false),
  startDaemon: vi.fn().mockReturnValue(true),
  stopDaemon: vi.fn().mockReturnValue(true),
}));

const mockLogStore = vi.hoisted(() => ({
  deleteJobLogs: vi.fn().mockReturnValue(true),
}));

const mockOutput = vi.hoisted(() => ({
  printInfo: vi.fn(),
  printError: vi.fn(),
}));

vi.mock('./store.js', () => ({
  CronStore: vi.fn(() => mockStore),
}));

vi.mock('./client.js', () => mockClient);

vi.mock('./log-store.js', () => ({
  CronLogStore: vi.fn(() => mockLogStore),
}));

vi.mock('../output.js', () => mockOutput);

// Mock readline to auto-respond to confirmation prompts
let confirmAnswer = 'y';

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_prompt: string, cb: (answer: string) => void) => {
      cb(confirmAnswer);
    }),
    close: vi.fn(),
  })),
}));

// Mock process.exit
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

import { cronList, cronDelete, cronDeleteAll, cronStop, cronBounce } from './cli.js';

// --- Helpers ---

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    name: 'Test Job',
    schedule: '0 * * * *',
    prompt: 'Do something',
    enabled: true,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function infoMessages(): string[] {
  return mockOutput.printInfo.mock.calls.map((c: unknown[]) => c[0] as string);
}

function errorMessages(): string[] {
  return mockOutput.printError.mock.calls.map((c: unknown[]) => c[0] as string);
}

// --- Tests ---

describe('cron CLI commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmAnswer = 'y';
    mockStore.loadJobs.mockReturnValue([]);
    mockClient.isDaemonRunning.mockReturnValue(false);
  });

  // ==================== cron-list ====================

  describe('cron-list', () => {
    it('shows empty message when no jobs', async () => {
      await cronList();
      expect(infoMessages()).toContain('No cron jobs configured.');
    });

    it('lists jobs with enabled/disabled status', async () => {
      mockStore.loadJobs.mockReturnValue([
        makeJob({ id: 'j1', name: 'Job A', enabled: true }),
        makeJob({ id: 'j2', name: 'Job B', enabled: false }),
      ]);
      mockClient.isDaemonRunning.mockReturnValue(true);

      await cronList();

      const msgs = infoMessages();
      expect(msgs.some(m => m.includes('Daemon: running'))).toBe(true);
      expect(msgs.some(m => m.includes('\u2713') && m.includes('Job A'))).toBe(true);
      expect(msgs.some(m => m.includes('\u2717') && m.includes('Job B'))).toBe(true);
      expect(msgs.some(m => m.includes('1 enabled, 1 disabled'))).toBe(true);
    });

    it('shows daemon stopped status', async () => {
      mockStore.loadJobs.mockReturnValue([makeJob()]);
      mockClient.isDaemonRunning.mockReturnValue(false);

      await cronList();

      const msgs = infoMessages();
      expect(msgs.some(m => m.includes('Daemon: stopped'))).toBe(true);
    });

    it('shows last run info when available', async () => {
      mockStore.loadJobs.mockReturnValue([
        makeJob({ lastRun: '2025-06-01T12:00:00Z', lastRunStatus: 'success' }),
      ]);

      await cronList();

      const msgs = infoMessages();
      expect(msgs.some(m => m.includes('2025-06-01T12:00:00Z') && m.includes('success'))).toBe(true);
    });

    it('shows "never run" for jobs without last run', async () => {
      mockStore.loadJobs.mockReturnValue([makeJob()]);

      await cronList();

      const msgs = infoMessages();
      expect(msgs.some(m => m.includes('never run'))).toBe(true);
    });
  });

  // ==================== cron-delete ====================

  describe('cron-delete', () => {
    it('exits with error for unknown IDs', async () => {
      mockStore.getJob.mockReturnValue(undefined);

      await cronDelete(['nonexistent']);

      expect(errorMessages().some(m => m.includes('not found'))).toBe(true);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('shows job names and deletes on confirmation', async () => {
      const job = makeJob();
      mockStore.getJob.mockReturnValue(job);
      confirmAnswer = 'y';

      await cronDelete(['job-1']);

      expect(mockStore.deleteJob).toHaveBeenCalledWith('job-1');
      expect(mockLogStore.deleteJobLogs).toHaveBeenCalledWith('job-1');
      expect(infoMessages().some(m => m.includes('Deleted: Test Job'))).toBe(true);
    });

    it('cancels on "N"', async () => {
      mockStore.getJob.mockReturnValue(makeJob());
      confirmAnswer = 'N';

      await cronDelete(['job-1']);

      expect(mockStore.deleteJob).not.toHaveBeenCalled();
      expect(infoMessages()).toContain('Cancelled.');
    });

    it('stops daemon if no enabled jobs remain after delete', async () => {
      mockStore.getJob.mockReturnValue(makeJob());
      mockStore.loadJobs.mockReturnValue([]); // no jobs left after delete
      mockClient.isDaemonRunning.mockReturnValue(true);
      confirmAnswer = 'y';

      await cronDelete(['job-1']);

      expect(mockClient.stopDaemon).toHaveBeenCalled();
    });

    it('deletes multiple jobs', async () => {
      mockStore.getJob
        .mockReturnValueOnce(makeJob({ id: 'j1', name: 'Job A' }))
        .mockReturnValueOnce(makeJob({ id: 'j2', name: 'Job B' }));
      confirmAnswer = 'y';

      await cronDelete(['j1', 'j2']);

      expect(mockStore.deleteJob).toHaveBeenCalledWith('j1');
      expect(mockStore.deleteJob).toHaveBeenCalledWith('j2');
      expect(mockLogStore.deleteJobLogs).toHaveBeenCalledWith('j1');
      expect(mockLogStore.deleteJobLogs).toHaveBeenCalledWith('j2');
    });
  });

  // ==================== cron-delete-all ====================

  describe('cron-delete-all', () => {
    it('skips when no jobs exist', async () => {
      await cronDeleteAll();

      expect(infoMessages()).toContain('No cron jobs to delete.');
      expect(mockStore.deleteJob).not.toHaveBeenCalled();
    });

    it('deletes all jobs and stops daemon on "y"', async () => {
      const jobs = [
        makeJob({ id: 'j1', name: 'Job A' }),
        makeJob({ id: 'j2', name: 'Job B' }),
      ];
      mockStore.loadJobs.mockReturnValue(jobs);
      mockClient.isDaemonRunning.mockReturnValue(true);
      confirmAnswer = 'y';

      await cronDeleteAll();

      expect(mockStore.deleteJob).toHaveBeenCalledWith('j1');
      expect(mockStore.deleteJob).toHaveBeenCalledWith('j2');
      expect(mockLogStore.deleteJobLogs).toHaveBeenCalledWith('j1');
      expect(mockLogStore.deleteJobLogs).toHaveBeenCalledWith('j2');
      expect(mockClient.stopDaemon).toHaveBeenCalled();
      expect(infoMessages().some(m => m.includes('Deleted 2 job(s)'))).toBe(true);
    });

    it('cancels on "N"', async () => {
      mockStore.loadJobs.mockReturnValue([makeJob()]);
      confirmAnswer = 'N';

      await cronDeleteAll();

      expect(mockStore.deleteJob).not.toHaveBeenCalled();
      expect(infoMessages()).toContain('Cancelled.');
    });

    it('does not stop daemon if already stopped', async () => {
      mockStore.loadJobs.mockReturnValue([makeJob()]);
      mockClient.isDaemonRunning.mockReturnValue(false);
      confirmAnswer = 'y';

      await cronDeleteAll();

      expect(mockClient.stopDaemon).not.toHaveBeenCalled();
    });
  });

  // ==================== cron-stop ====================

  describe('cron-stop (no args)', () => {
    it('stops running daemon', async () => {
      mockClient.isDaemonRunning.mockReturnValue(true);

      await cronStop();

      expect(mockClient.stopDaemon).toHaveBeenCalled();
      expect(infoMessages()).toContain('Daemon stopped.');
    });

    it('prints "not running" when daemon already stopped', async () => {
      mockClient.isDaemonRunning.mockReturnValue(false);

      await cronStop();

      expect(mockClient.stopDaemon).not.toHaveBeenCalled();
      expect(infoMessages()).toContain('Daemon is not running.');
    });
  });

  describe('cron-stop (with IDs)', () => {
    it('disables specified jobs', async () => {
      const job = makeJob({ id: 'j1', name: 'Job A', enabled: true });
      mockStore.getJob.mockReturnValue(job);
      mockStore.loadJobs.mockReturnValue([{ ...job, enabled: false }]);

      await cronStop(['j1']);

      expect(mockStore.updateJob).toHaveBeenCalledWith('j1', { enabled: false });
      expect(infoMessages().some(m => m.includes('Disabled: Job A'))).toBe(true);
    });

    it('exits with error for unknown IDs', async () => {
      mockStore.getJob.mockReturnValue(undefined);

      await cronStop(['nonexistent']);

      expect(errorMessages().some(m => m.includes('not found'))).toBe(true);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('stops daemon when no enabled jobs remain', async () => {
      const job = makeJob({ id: 'j1', enabled: true });
      mockStore.getJob.mockReturnValue(job);
      mockStore.loadJobs.mockReturnValue([]); // simulate all disabled
      mockClient.isDaemonRunning.mockReturnValue(true);

      await cronStop(['j1']);

      expect(mockClient.stopDaemon).toHaveBeenCalled();
    });
  });

  // ==================== cron-bounce ====================

  describe('cron-bounce (no args)', () => {
    it('restarts running daemon', async () => {
      mockStore.loadJobs.mockReturnValue([makeJob({ enabled: true })]);
      mockClient.isDaemonRunning.mockReturnValue(true);

      await cronBounce();

      expect(mockClient.stopDaemon).toHaveBeenCalled();
      expect(mockClient.startDaemon).toHaveBeenCalled();
      expect(infoMessages().some(m => m.includes('restarted'))).toBe(true);
    });

    it('starts daemon if not running but has enabled jobs', async () => {
      mockStore.loadJobs.mockReturnValue([makeJob({ enabled: true })]);
      mockClient.isDaemonRunning.mockReturnValue(false);

      await cronBounce();

      expect(mockClient.stopDaemon).not.toHaveBeenCalled();
      expect(mockClient.startDaemon).toHaveBeenCalled();
      expect(infoMessages().some(m => m.includes('started'))).toBe(true);
    });

    it('prints message when no enabled jobs', async () => {
      mockStore.loadJobs.mockReturnValue([makeJob({ enabled: false })]);
      mockClient.isDaemonRunning.mockReturnValue(false);

      await cronBounce();

      expect(mockClient.startDaemon).not.toHaveBeenCalled();
      expect(infoMessages().some(m => m.includes('No enabled jobs'))).toBe(true);
    });

    it('stops daemon and does not restart when no enabled jobs', async () => {
      mockStore.loadJobs.mockReturnValue([makeJob({ enabled: false })]);
      mockClient.isDaemonRunning.mockReturnValue(true);

      await cronBounce();

      expect(mockClient.stopDaemon).toHaveBeenCalled();
      expect(mockClient.startDaemon).not.toHaveBeenCalled();
    });
  });

  describe('cron-bounce (with IDs)', () => {
    it('disables then re-enables specified jobs', async () => {
      const job = makeJob({ id: 'j1', name: 'Job A', enabled: true });
      mockStore.getJob.mockReturnValue(job);

      await cronBounce(['j1']);

      expect(mockStore.updateJob).toHaveBeenCalledWith('j1', { enabled: false });
      expect(mockStore.updateJob).toHaveBeenCalledWith('j1', { enabled: true });
    });

    it('skips already-disabled jobs', async () => {
      const job = makeJob({ id: 'j1', name: 'Job A', enabled: false });
      mockStore.getJob.mockReturnValue(job);

      await cronBounce(['j1']);

      expect(mockStore.updateJob).not.toHaveBeenCalled();
      expect(infoMessages().some(m => m.includes('Skipping') && m.includes('already disabled'))).toBe(true);
    });

    it('exits with error for unknown IDs', async () => {
      mockStore.getJob.mockReturnValue(undefined);

      await cronBounce(['nonexistent']);

      expect(errorMessages().some(m => m.includes('not found'))).toBe(true);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('ensures daemon is running after bounce', async () => {
      const job = makeJob({ id: 'j1', enabled: true });
      mockStore.getJob.mockReturnValue(job);
      mockClient.isDaemonRunning.mockReturnValue(false);

      await cronBounce(['j1']);

      expect(mockClient.startDaemon).toHaveBeenCalled();
    });
  });
});
