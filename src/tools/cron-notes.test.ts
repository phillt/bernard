import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CronNoteEntry } from '../cron/notes-store.js';

// --- Mocks ---

const mockNotesStore = {
  read: vi.fn(),
  append: vi.fn(),
  listJobIds: vi.fn(),
  clear: vi.fn(),
  entriesForRun: vi.fn(),
};

const mockCronStore = {
  getJob: vi.fn(),
};

vi.mock('../cron/notes-store.js', () => ({
  CronNotesStore: vi.fn(() => mockNotesStore),
  MAX_NOTE_LENGTH: 1000,
}));

vi.mock('../cron/store.js', () => ({
  CronStore: vi.fn(() => mockCronStore),
}));

import { createCronNotesTools } from './cron-notes.js';

function makeEntry(overrides: Partial<CronNoteEntry> = {}): CronNoteEntry {
  return {
    timestamp: '2025-01-01T00:00:00.000Z',
    text: 'sent email',
    ...overrides,
  };
}

describe('cron notes tools', () => {
  let tools: ReturnType<typeof createCronNotesTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesStore.read.mockReturnValue({ jobId: 'job-1', entries: [] });
    mockNotesStore.listJobIds.mockReturnValue([]);
    mockCronStore.getJob.mockReturnValue(undefined);
    tools = createCronNotesTools();
  });

  describe('cron_notes_read', () => {
    it('returns message when no notes exist', async () => {
      mockNotesStore.read.mockReturnValue({ jobId: 'job-1', entries: [] });

      const result = await tools.cron_notes_read.execute!({ job_id: 'job-1' }, {} as any);

      expect(result).toContain('No notes recorded');
      expect(result).toContain('job-1');
    });

    it('formats entries with timestamp and text', async () => {
      mockNotesStore.read.mockReturnValue({
        jobId: 'job-1',
        entries: [makeEntry({ text: 'created issue #42' })],
      });

      const result = await tools.cron_notes_read.execute!({ job_id: 'job-1' }, {} as any);

      expect(result).toContain('1 entry');
      expect(result).toContain('2025-01-01T00:00:00.000Z');
      expect(result).toContain('created issue #42');
    });

    it('includes truncated runId when present', async () => {
      mockNotesStore.read.mockReturnValue({
        jobId: 'job-1',
        entries: [makeEntry({ runId: 'abcdef12-3456-7890' })],
      });

      const result = await tools.cron_notes_read.execute!({ job_id: 'job-1' }, {} as any);

      expect(result).toContain('run:abcdef12');
      expect(result).not.toContain('abcdef12-3456-7890');
    });
  });

  describe('cron_notes_write', () => {
    it('appends note and returns confirmation', async () => {
      mockNotesStore.read.mockReturnValue({
        jobId: 'job-1',
        entries: [makeEntry(), makeEntry()],
      });

      const result = await tools.cron_notes_write.execute!(
        { job_id: 'job-1', text: 'sent weekly summary' },
        {} as any,
      );

      expect(mockNotesStore.append).toHaveBeenCalledWith('job-1', 'sent weekly summary');
      expect(result).toContain('Appended note');
      expect(result).toContain('2 entries');
    });

    it('rejects text exceeding 1000 characters', async () => {
      const longText = 'x'.repeat(1001);

      const result = await tools.cron_notes_write.execute!(
        { job_id: 'job-1', text: longText },
        {} as any,
      );

      expect(result).toContain('Error:');
      expect(result).toContain('1000');
      expect(result).toContain('1001');
      expect(mockNotesStore.append).not.toHaveBeenCalled();
    });

    it('accepts text exactly at the 1000 char limit', async () => {
      mockNotesStore.read.mockReturnValue({ jobId: 'job-1', entries: [makeEntry()] });
      const text = 'x'.repeat(1000);

      const result = await tools.cron_notes_write.execute!(
        { job_id: 'job-1', text },
        {} as any,
      );

      expect(mockNotesStore.append).toHaveBeenCalledWith('job-1', text);
      expect(result).toContain('Appended note');
    });
  });

  describe('cron_notes_list', () => {
    it('returns message when no jobs have notes', async () => {
      mockNotesStore.listJobIds.mockReturnValue([]);

      const result = await tools.cron_notes_list.execute!({}, {} as any);

      expect(result).toContain('No cron jobs have notes');
    });

    it('lists job ids with entry counts', async () => {
      mockNotesStore.listJobIds.mockReturnValue(['job-a', 'job-b']);
      mockNotesStore.read
        .mockReturnValueOnce({ jobId: 'job-a', entries: [makeEntry(), makeEntry()] })
        .mockReturnValueOnce({ jobId: 'job-b', entries: [makeEntry()] });

      const result = await tools.cron_notes_list.execute!({}, {} as any);

      expect(result).toContain('job-a');
      expect(result).toContain('2 entries');
      expect(result).toContain('job-b');
      expect(result).toContain('1 entry');
    });

    it('enriches job ids with names when CronStore knows them', async () => {
      mockNotesStore.listJobIds.mockReturnValue(['job-a']);
      mockNotesStore.read.mockReturnValue({ jobId: 'job-a', entries: [makeEntry()] });
      mockCronStore.getJob.mockReturnValue({ id: 'job-a', name: 'Daily summary' });

      const result = await tools.cron_notes_list.execute!({}, {} as any);

      expect(result).toContain('job-a (Daily summary)');
    });
  });

  describe('cron_notes_view', () => {
    it('returns message when no notes exist', async () => {
      mockNotesStore.read.mockReturnValue({ jobId: 'job-1', entries: [] });

      const result = await tools.cron_notes_view.execute!({ job_id: 'job-1' }, {} as any);

      expect(result).toContain('No notes recorded');
    });

    it('formats entries in human-friendly blocks', async () => {
      mockNotesStore.read.mockReturnValue({
        jobId: 'job-1',
        entries: [
          makeEntry({ text: 'first entry' }),
          makeEntry({ text: 'second entry', runId: 'abcdef12-3456' }),
        ],
      });

      const result = await tools.cron_notes_view.execute!({ job_id: 'job-1' }, {} as any);

      expect(result).toContain('2 entries');
      expect(result).toContain('first entry');
      expect(result).toContain('second entry');
      expect(result).toContain('(run abcdef12)');
      // view uses bullet format, distinct from read's compact brackets
      expect(result).toContain('•');
    });

    it('uses job name in header when available', async () => {
      mockNotesStore.read.mockReturnValue({
        jobId: 'job-1',
        entries: [makeEntry()],
      });
      mockCronStore.getJob.mockReturnValue({ id: 'job-1', name: 'Daily summary' });

      const result = await tools.cron_notes_view.execute!({ job_id: 'job-1' }, {} as any);

      expect(result).toContain('Daily summary');
      expect(result).toContain('job-1');
    });
  });
});
