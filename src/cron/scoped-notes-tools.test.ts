import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CronNotesStore } from './notes-store.js';
import { createScopedCronNotesTools } from './scoped-notes-tools.js';

function makeMockStore(): CronNotesStore {
  return {
    read: vi.fn().mockReturnValue({ jobId: 'job-123', entries: [] }),
    append: vi.fn(),
    listJobIds: vi.fn().mockReturnValue([]),
    clear: vi.fn(),
    entriesForRun: vi.fn().mockReturnValue([]),
  } as unknown as CronNotesStore;
}

describe('createScopedCronNotesTools', () => {
  const jobId = 'job-123';
  const runId = 'run-abcdef12-3456';
  let store: CronNotesStore;

  beforeEach(() => {
    store = makeMockStore();
  });

  it('returns both scoped tools', () => {
    const tools = createScopedCronNotesTools(store, jobId, runId);

    expect(tools).toHaveProperty('cron_notes_read');
    expect(tools).toHaveProperty('cron_notes_write');
  });

  describe('cron_notes_write', () => {
    it('tags appended entry with the bound jobId and runId', async () => {
      const tools = createScopedCronNotesTools(store, jobId, runId);

      const result = await tools.cron_notes_write.execute!({ text: 'sent email' }, {} as any);

      expect(store.append).toHaveBeenCalledWith(jobId, 'sent email', runId);
      expect(result).toContain('Note appended');
      expect(result).toContain(runId.slice(0, 8));
    });

    it('passes the bound runId even when multiple writes occur', async () => {
      const tools = createScopedCronNotesTools(store, jobId, runId);

      await tools.cron_notes_write.execute!({ text: 'first' }, {} as any);
      await tools.cron_notes_write.execute!({ text: 'second' }, {} as any);

      expect(store.append).toHaveBeenNthCalledWith(1, jobId, 'first', runId);
      expect(store.append).toHaveBeenNthCalledWith(2, jobId, 'second', runId);
    });
  });

  describe('cron_notes_read', () => {
    it('reads only the bound jobId', async () => {
      const tools = createScopedCronNotesTools(store, jobId, runId);

      await tools.cron_notes_read.execute!({}, {} as any);

      expect(store.read).toHaveBeenCalledWith(jobId);
    });

    it('returns empty-state message when no prior notes exist', async () => {
      vi.mocked(store.read).mockReturnValue({ jobId, entries: [] });
      const tools = createScopedCronNotesTools(store, jobId, runId);

      const result = await tools.cron_notes_read.execute!({}, {} as any);

      expect(result).toContain('No prior notes');
    });

    it('formats a single entry with singular "entry"', async () => {
      vi.mocked(store.read).mockReturnValue({
        jobId,
        entries: [{ timestamp: '2026-04-19T10:00:00Z', text: 'sent email', runId: 'abcdef12' }],
      });
      const tools = createScopedCronNotesTools(store, jobId, runId);

      const result = await tools.cron_notes_read.execute!({}, {} as any);

      expect(result).toContain('1 entry');
      expect(result).toContain('sent email');
      expect(result).toContain('run:abcdef12');
    });

    it('formats multiple entries with plural "entries"', async () => {
      vi.mocked(store.read).mockReturnValue({
        jobId,
        entries: [
          { timestamp: '2026-04-19T10:00:00Z', text: 'a', runId: 'abcdef12' },
          { timestamp: '2026-04-19T10:00:01Z', text: 'b', runId: 'abcdef12' },
        ],
      });
      const tools = createScopedCronNotesTools(store, jobId, runId);

      const result = await tools.cron_notes_read.execute!({}, {} as any);

      expect(result).toContain('2 entries');
      expect(result).toContain('a');
      expect(result).toContain('b');
    });

    it('omits the run prefix for entries without a runId', async () => {
      vi.mocked(store.read).mockReturnValue({
        jobId,
        entries: [{ timestamp: '2026-04-19T10:00:00Z', text: 'orphan entry' }],
      });
      const tools = createScopedCronNotesTools(store, jobId, runId);

      const result = await tools.cron_notes_read.execute!({}, {} as any);

      expect(result).toContain('orphan entry');
      expect(result).not.toContain('run:');
    });
  });
});
