import { tool } from 'ai';
import { z } from 'zod';
import { CronNotesStore, MAX_NOTE_LENGTH } from './notes-store.js';
import { formatEntryCompact } from '../tools/cron-notes.js';
import { debugLog } from '../logger.js';

/**
 * Builds `cron_notes_read` and `cron_notes_write` tools pre-scoped to a single
 * cron job and run. The daemon runner spreads these into its tools dict so the
 * agent sees zero/one-arg versions that cannot read or write other jobs'
 * notes and auto-tag writes with the current `runId`.
 */
export function createScopedCronNotesTools(
  notesStore: CronNotesStore,
  jobId: string,
  runId: string,
) {
  const scopedNotesRead = tool({
    description:
      'Read notes previously written for this cron job by prior runs. Call this before acting to avoid duplicate work.',
    parameters: z.object({}),
    execute: async (): Promise<string> => {
      debugLog('cron_notes_read:scoped:execute', { jobId });
      const notes = notesStore.read(jobId);
      if (notes.entries.length === 0) {
        return `No prior notes for this job.`;
      }
      const label = notes.entries.length === 1 ? 'entry' : 'entries';
      const lines = notes.entries.map(formatEntryCompact);
      return `Prior notes (${notes.entries.length} ${label}):\n${lines.join('\n')}`;
    },
  });

  const scopedNotesWrite = tool({
    description:
      "Append a short factual note recording a significant action this run took (e.g. 'Sent email to user@example.com', 'Created issue #123'). Keep it to one line.",
    parameters: z.object({
      text: z
        .string()
        .min(1)
        .max(MAX_NOTE_LENGTH)
        .describe('Short factual description of the action'),
    }),
    execute: async ({ text }): Promise<string> => {
      debugLog('cron_notes_write:scoped:execute', { jobId, runId, text });
      notesStore.append(jobId, text, runId);
      return `Note appended (run ${runId.slice(0, 8)}).`;
    },
  });

  return {
    cron_notes_read: scopedNotesRead,
    cron_notes_write: scopedNotesWrite,
  };
}
