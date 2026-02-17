import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => ({ size: 0 })),
  readFileSync: vi.fn(() => ''),
  appendFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
}));

const fs = await import('node:fs');

import { CronLogStore, type CronLogEntry } from './log-store.js';

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
    steps: [],
    totalUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    ...overrides,
  };
}

describe('CronLogStore', () => {
  let store: CronLogStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new CronLogStore();
  });

  it('creates logs directory on construction', () => {
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('logs'), { recursive: true });
  });

  describe('appendEntry', () => {
    it('appends a JSONL line', () => {
      const entry = makeEntry();
      store.appendEntry(entry);

      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.stringContaining('job-1.jsonl'),
        expect.stringContaining('"runId":"run-1"'),
        'utf-8',
      );
    });

    it('appends with trailing newline', () => {
      const entry = makeEntry();
      store.appendEntry(entry);

      const written = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
      expect(written.endsWith('\n')).toBe(true);
    });

    it('auto-rotates when file exceeds 5MB', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ size: 6 * 1024 * 1024 } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('{"line":1}\n{"line":2}\n');

      const entry = makeEntry();
      store.appendEntry(entry);

      // Should have written rotated file (writeFileSync for rotation) then appended
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
      expect(fs.appendFileSync).toHaveBeenCalled();
    });
  });

  describe('getEntries', () => {
    it('returns empty array when no log file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.getEntries('job-1')).toEqual([]);
    });

    it('returns entries in newest-first order', () => {
      const line1 = JSON.stringify(makeEntry({ runId: 'run-1' }));
      const line2 = JSON.stringify(makeEntry({ runId: 'run-2' }));
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`${line1}\n${line2}\n`);

      const entries = store.getEntries('job-1');
      expect(entries).toHaveLength(2);
      expect(entries[0].runId).toBe('run-2');
      expect(entries[1].runId).toBe('run-1');
    });

    it('respects limit and offset', () => {
      const lines =
        Array.from({ length: 5 }, (_, i) => JSON.stringify(makeEntry({ runId: `run-${i}` }))).join(
          '\n',
        ) + '\n';
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(lines);

      const entries = store.getEntries('job-1', 2, 1);
      expect(entries).toHaveLength(2);
      // newest first, offset=1 skips the most recent (run-4), so we get run-3 and run-2
      expect(entries[0].runId).toBe('run-3');
      expect(entries[1].runId).toBe('run-2');
    });

    it('skips corrupted lines', () => {
      const good = JSON.stringify(makeEntry({ runId: 'run-1' }));
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`${good}\n{bad json\n`);

      const entries = store.getEntries('job-1');
      expect(entries).toHaveLength(1);
    });
  });

  describe('getEntry', () => {
    it('returns undefined when no log file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.getEntry('job-1', 'run-1')).toBeUndefined();
    });

    it('finds entry by runId', () => {
      const line1 = JSON.stringify(makeEntry({ runId: 'run-1' }));
      const line2 = JSON.stringify(makeEntry({ runId: 'run-2' }));
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`${line1}\n${line2}\n`);

      const entry = store.getEntry('job-1', 'run-2');
      expect(entry).toBeDefined();
      expect(entry!.runId).toBe('run-2');
    });

    it('returns undefined for unknown runId', () => {
      const line = JSON.stringify(makeEntry({ runId: 'run-1' }));
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`${line}\n`);

      expect(store.getEntry('job-1', 'nope')).toBeUndefined();
    });
  });

  describe('listJobIds', () => {
    it('returns empty array when no logs dir', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.listJobIds()).toEqual([]);
    });

    it('extracts job IDs from filenames', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['abc.jsonl', 'def.jsonl', 'readme.txt'] as any);

      expect(store.listJobIds()).toEqual(['abc', 'def']);
    });
  });

  describe('getEntryCount', () => {
    it('returns 0 when no log file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.getEntryCount('job-1')).toBe(0);
    });

    it('counts non-empty lines', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('line1\nline2\nline3\n');

      expect(store.getEntryCount('job-1')).toBe(3);
    });
  });

  describe('rotate', () => {
    it('keeps last N entries', () => {
      const lines =
        Array.from({ length: 10 }, (_, i) => JSON.stringify(makeEntry({ runId: `run-${i}` }))).join(
          '\n',
        ) + '\n';
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(lines);

      store.rotate('job-1', 3);

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const keptLines = written.trim().split('\n');
      expect(keptLines).toHaveLength(3);
      expect(keptLines[0]).toContain('run-7');
      expect(keptLines[2]).toContain('run-9');
    });

    it('does nothing when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      store.rotate('job-1');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('deleteJobLogs', () => {
    it('deletes the log file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(store.deleteJobLogs('job-1')).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('job-1.jsonl'));
    });

    it('returns false when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.deleteJobLogs('job-1')).toBe(false);
    });
  });
});
