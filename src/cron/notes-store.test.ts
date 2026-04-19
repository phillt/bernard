import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
}));

const fs = await import('node:fs');

import { CronNotesStore, type CronNotes } from './notes-store.js';

function lastWrittenPayload(): CronNotes {
  const call = vi.mocked(fs.writeFileSync).mock.calls.at(-1);
  if (!call) throw new Error('writeFileSync was not called');
  return JSON.parse(call[1] as string) as CronNotes;
}

describe('CronNotesStore', () => {
  let store: CronNotesStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new CronNotesStore();
  });

  it('creates notes directory on construction', () => {
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('notes'), {
      recursive: true,
    });
  });

  describe('append', () => {
    it('writes a new file when none exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const { entry, total } = store.append('job-1', 'sent email');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/job-1\.json\.tmp$/),
        expect.stringContaining('"sent email"'),
        'utf-8',
      );
      expect(fs.renameSync).toHaveBeenCalled();
      expect(entry.text).toBe('sent email');
      expect(entry.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(entry.runId).toBeUndefined();
      expect(total).toBe(1);
    });

    it('tags entry with runId when provided', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const { entry } = store.append('job-1', 'created issue #42', 'run-abc');

      expect(entry.runId).toBe('run-abc');
      expect(lastWrittenPayload().entries[0].runId).toBe('run-abc');
    });

    it('appends to existing entries', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          jobId: 'job-1',
          entries: [{ timestamp: '2025-01-01T00:00:00Z', text: 'old' }],
        }),
      );

      store.append('job-1', 'new');

      const payload = lastWrittenPayload();
      expect(payload.entries).toHaveLength(2);
      expect(payload.entries[0].text).toBe('old');
      expect(payload.entries[1].text).toBe('new');
    });

    it('caps entries at 100 (drops oldest)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const existing = Array.from({ length: 100 }, (_, i) => ({
        timestamp: `2025-01-01T00:00:${String(i).padStart(2, '0')}Z`,
        text: `entry-${i}`,
      }));
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ jobId: 'job-1', entries: existing }),
      );

      const { total } = store.append('job-1', 'entry-100');

      const payload = lastWrittenPayload();
      expect(payload.entries).toHaveLength(100);
      expect(payload.entries[0].text).toBe('entry-1');
      expect(payload.entries[99].text).toBe('entry-100');
      expect(total).toBe(100);
    });
  });

  describe('read', () => {
    it('returns empty notes when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const notes = store.read('job-1');

      expect(notes).toEqual({ jobId: 'job-1', entries: [] });
    });

    it('parses a valid notes file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          jobId: 'job-1',
          entries: [{ timestamp: '2025-01-01T00:00:00Z', text: 'hi', runId: 'r-1' }],
        }),
      );

      const notes = store.read('job-1');

      expect(notes.entries).toHaveLength(1);
      expect(notes.entries[0].text).toBe('hi');
      expect(notes.entries[0].runId).toBe('r-1');
    });

    it('returns empty notes on malformed JSON', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json');

      const notes = store.read('job-1');

      expect(notes.entries).toEqual([]);
    });
  });

  describe('sanitizeJobId', () => {
    it('strips path-traversal characters before reading', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const notes = store.read('../evil');

      expect(notes.jobId).toBe('evil');
    });

    it('rejects jobIds that sanitize to empty', () => {
      expect(() => store.read('../../')).toThrow(/Invalid jobId/);
      expect(() => store.append('!@#', 'x')).toThrow(/Invalid jobId/);
    });
  });

  describe('listJobIds', () => {
    it('returns empty when directory does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.listJobIds()).toEqual([]);
    });

    it('returns job ids stripped of .json extension', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['job-1.json', 'job-2.json', 'ignore.txt'] as any);

      expect(store.listJobIds()).toEqual(['job-1', 'job-2']);
    });
  });

  describe('clear', () => {
    it('returns false when no notes file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.clear('job-1')).toBe(false);
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('unlinks the file and returns true when it exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(store.clear('job-1')).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/job-1\.json$/));
    });
  });

  describe('entriesForRun', () => {
    it('filters entries to only those with the given runId', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          jobId: 'job-1',
          entries: [
            { timestamp: 't1', text: 'a', runId: 'r-1' },
            { timestamp: 't2', text: 'b', runId: 'r-2' },
            { timestamp: 't3', text: 'c', runId: 'r-1' },
            { timestamp: 't4', text: 'd' },
          ],
        }),
      );

      const matches = store.entriesForRun('job-1', 'r-1');

      expect(matches.map((e) => e.text)).toEqual(['a', 'c']);
    });
  });
});
