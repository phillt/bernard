import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CronLogEntry } from '../cron/log-store.js';

// --- Mocks ---

const mockLogStore = {
  getEntries: vi.fn().mockReturnValue([]),
  getEntry: vi.fn(),
  getEntryCount: vi.fn().mockReturnValue(0),
  listJobIds: vi.fn().mockReturnValue([]),
  rotate: vi.fn(),
  deleteJobLogs: vi.fn(),
};

vi.mock('../cron/log-store.js', () => ({
  CronLogStore: vi.fn(() => mockLogStore),
}));

import { createCronLogTools } from './cron-logs.js';

function makeEntry(overrides: Partial<CronLogEntry> = {}): CronLogEntry {
  return {
    runId: 'run-1',
    jobId: 'job-1',
    jobName: 'Test Job',
    prompt: 'do stuff',
    startedAt: '2025-01-01T00:00:00.000Z',
    completedAt: '2025-01-01T00:00:01.000Z',
    durationMs: 1000,
    success: true,
    finalOutput: 'done',
    steps: [
      {
        stepIndex: 0,
        timestamp: '2025-01-01T00:00:00.500Z',
        text: 'thinking',
        toolCalls: [{ toolName: 'shell', toolCallId: 'tc-1', args: { command: 'ls' } }],
        toolResults: [{ toolName: 'shell', toolCallId: 'tc-1', result: 'file1\nfile2' }],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: 'tool-calls',
      },
    ],
    totalUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    ...overrides,
  };
}

describe('cron log tools', () => {
  let tools: ReturnType<typeof createCronLogTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    tools = createCronLogTools();
  });

  describe('cron_logs_list', () => {
    it('returns message when no logs exist', async () => {
      mockLogStore.getEntryCount.mockReturnValue(0);
      mockLogStore.getEntries.mockReturnValue([]);

      const result = await tools.cron_logs_list.execute!(
        { job_id: 'job-1', limit: 10, offset: 0 },
        {} as any,
      );

      expect(result).toContain('No execution logs found');
    });

    it('returns summary lines for entries', async () => {
      const entry = makeEntry();
      mockLogStore.getEntryCount.mockReturnValue(1);
      mockLogStore.getEntries.mockReturnValue([entry]);

      const result = await tools.cron_logs_list.execute!(
        { job_id: 'job-1', limit: 10, offset: 0 },
        {} as any,
      );

      expect(result).toContain('[OK]');
      expect(result).toContain('1000ms');
      expect(result).toContain('1 steps');
      expect(result).toContain('1 tool calls');
      expect(result).toContain('run:run-1');
    });

    it('shows ERR for failed entries', async () => {
      const entry = makeEntry({ success: false });
      mockLogStore.getEntryCount.mockReturnValue(1);
      mockLogStore.getEntries.mockReturnValue([entry]);

      const result = await tools.cron_logs_list.execute!(
        { job_id: 'job-1', limit: 10, offset: 0 },
        {} as any,
      );

      expect(result).toContain('[ERR]');
    });

    it('shows offset message when past end', async () => {
      mockLogStore.getEntryCount.mockReturnValue(5);
      mockLogStore.getEntries.mockReturnValue([]);

      const result = await tools.cron_logs_list.execute!(
        { job_id: 'job-1', limit: 10, offset: 10 },
        {} as any,
      );

      expect(result).toContain('No more entries');
      expect(result).toContain('total: 5');
    });
  });

  describe('cron_logs_get', () => {
    it('returns message when entry not found', async () => {
      mockLogStore.getEntry.mockReturnValue(undefined);

      const result = await tools.cron_logs_get.execute!(
        { job_id: 'job-1', run_id: 'nope' },
        {} as any,
      );

      expect(result).toContain('No log entry found');
    });

    it('returns full trace for entry', async () => {
      const entry = makeEntry();
      mockLogStore.getEntry.mockReturnValue(entry);

      const result = await tools.cron_logs_get.execute!(
        { job_id: 'job-1', run_id: 'run-1' },
        {} as any,
      );

      expect(result).toContain('Run: run-1');
      expect(result).toContain('Status: success');
      expect(result).toContain('Step 0');
      expect(result).toContain('Tool call: shell');
      expect(result).toContain('Tool result [shell]');
      expect(result).toContain('Final Output');
    });

    it('includes error field for failed runs', async () => {
      const entry = makeEntry({ success: false, error: 'API timeout' });
      mockLogStore.getEntry.mockReturnValue(entry);

      const result = await tools.cron_logs_get.execute!(
        { job_id: 'job-1', run_id: 'run-1' },
        {} as any,
      );

      expect(result).toContain('Status: error');
      expect(result).toContain('Error: API timeout');
    });

    it('truncates long tool results', async () => {
      const longResult = 'x'.repeat(1000);
      const entry = makeEntry({
        steps: [
          {
            stepIndex: 0,
            timestamp: '2025-01-01T00:00:00.500Z',
            text: '',
            toolCalls: [{ toolName: 'shell', toolCallId: 'tc-1', args: { command: 'ls' } }],
            toolResults: [{ toolName: 'shell', toolCallId: 'tc-1', result: longResult }],
            usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
            finishReason: 'tool-calls',
          },
        ],
      });
      mockLogStore.getEntry.mockReturnValue(entry);

      const result = await tools.cron_logs_get.execute!(
        { job_id: 'job-1', run_id: 'run-1' },
        {} as any,
      );

      expect(result).toContain('(truncated)');
      // The full 1000 chars should NOT appear
      expect(result).not.toContain(longResult);
    });
  });

  describe('cron_logs_summary', () => {
    it('returns message when no logs exist', async () => {
      mockLogStore.getEntryCount.mockReturnValue(0);

      const result = await tools.cron_logs_summary.execute!({ job_id: 'job-1' }, {} as any);

      expect(result).toContain('No execution logs found');
    });

    it('calculates statistics', async () => {
      const entries = [
        makeEntry({
          runId: 'r1',
          success: true,
          durationMs: 1000,
          totalUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        }),
        makeEntry({
          runId: 'r2',
          success: true,
          durationMs: 2000,
          totalUsage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
        }),
        makeEntry({
          runId: 'r3',
          success: false,
          durationMs: 500,
          totalUsage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
        }),
      ];
      mockLogStore.getEntryCount.mockReturnValue(3);
      mockLogStore.getEntries.mockReturnValue(entries);

      const result = await tools.cron_logs_summary.execute!({ job_id: 'job-1' }, {} as any);

      expect(result).toContain('66.7%');
      expect(result).toContain('2 ok');
      expect(result).toContain('1 errors');
      expect(result).toContain('525'); // total tokens = 150+300+75
      expect(result).toContain('175'); // avg tokens
    });
  });

  describe('cron_logs_cleanup', () => {
    it('deletes logs', async () => {
      mockLogStore.deleteJobLogs.mockReturnValue(true);

      const result = await tools.cron_logs_cleanup.execute!(
        { job_id: 'job-1', action: 'delete', keep: 500 },
        {} as any,
      );

      expect(result).toContain('deleted');
      expect(mockLogStore.deleteJobLogs).toHaveBeenCalledWith('job-1');
    });

    it('returns message when no log file to delete', async () => {
      mockLogStore.deleteJobLogs.mockReturnValue(false);

      const result = await tools.cron_logs_cleanup.execute!(
        { job_id: 'job-1', action: 'delete', keep: 500 },
        {} as any,
      );

      expect(result).toContain('No log file found');
    });

    it('rotates logs', async () => {
      mockLogStore.getEntryCount
        .mockReturnValueOnce(100) // before
        .mockReturnValueOnce(50); // after

      const result = await tools.cron_logs_cleanup.execute!(
        { job_id: 'job-1', action: 'rotate', keep: 50 },
        {} as any,
      );

      expect(result).toContain('100');
      expect(result).toContain('50');
      expect(mockLogStore.rotate).toHaveBeenCalledWith('job-1', 50);
    });

    it('returns message when nothing to rotate', async () => {
      mockLogStore.getEntryCount.mockReturnValue(0);

      const result = await tools.cron_logs_cleanup.execute!(
        { job_id: 'job-1', action: 'rotate', keep: 500 },
        {} as any,
      );

      expect(result).toContain('No execution logs found');
    });
  });
});
