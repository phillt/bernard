import { tool } from 'ai';
import { z } from 'zod';
import { CronNotesStore, MAX_NOTE_LENGTH, type CronNoteEntry } from '../cron/notes-store.js';
import { CronStore } from '../cron/store.js';
import { debugLog } from '../logger.js';

function pluralizeEntries(n: number): string {
  return `${n} ${n === 1 ? 'entry' : 'entries'}`;
}

export function formatEntryCompact(e: CronNoteEntry): string {
  const run = e.runId ? ` run:${e.runId.slice(0, 8)}` : '';
  return `  [${e.timestamp}${run}] ${e.text}`;
}

function formatEntryView(e: CronNoteEntry): string {
  const run = e.runId ? ` (run ${e.runId.slice(0, 8)})` : '';
  return `• ${e.timestamp}${run}\n    ${e.text}`;
}

/**
 * Creates tools for reading and maintaining persistent per-job cron notes.
 *
 * All tools take a `job_id` parameter. In daemon runs, these globals are
 * overridden by job-scoped closures in {@link ../cron/runner} that auto-tag
 * writes with the current runId; see runner.ts for the self-scoped variants.
 */
export function createCronNotesTools() {
  const notesStore = new CronNotesStore();
  const cronStore = new CronStore();

  return {
    cron_notes_read: tool({
      description:
        'Read all persistent notes for a cron job. Returns structured output of every note entry (timestamp, optional runId, text). Notes persist across daemon restarts and record actions prior runs took.',
      parameters: z.object({
        job_id: z.string().describe('Job ID to read notes for'),
      }),
      execute: async ({ job_id }): Promise<string> => {
        debugLog('cron_notes_read:execute', { job_id });

        const notes = notesStore.read(job_id);
        if (notes.entries.length === 0) {
          return `No notes recorded for job "${job_id}".`;
        }

        const lines = notes.entries.map(formatEntryCompact);
        return `Notes for job "${job_id}" (${pluralizeEntries(notes.entries.length)}):\n${lines.join('\n')}`;
      },
    }),

    cron_notes_write: tool({
      description:
        'Append a persistent note to a cron job. Use short factual entries recording significant actions (e.g. "Sent email to user@example.com", "Created issue #123"). Notes persist across daemon restarts.',
      parameters: z.object({
        job_id: z.string().describe('Job ID to attach the note to'),
        text: z.string().min(1).describe('Short factual description of the action'),
      }),
      execute: async ({ job_id, text }): Promise<string> => {
        debugLog('cron_notes_write:execute', { job_id, text });

        if (text.length > MAX_NOTE_LENGTH) {
          return `Error: note text exceeds ${MAX_NOTE_LENGTH} characters (got ${text.length}). Summarize first.`;
        }

        const { total } = notesStore.append(job_id, text);
        return `Appended note to job "${job_id}" (${pluralizeEntries(total)} total).`;
      },
    }),

    cron_notes_list: tool({
      description:
        'List all cron jobs that have persistent notes, with an entry count per job. Use to discover which jobs are tracking state.',
      parameters: z.object({}),
      execute: async (): Promise<string> => {
        debugLog('cron_notes_list:execute', {});

        const jobIds = notesStore.listJobIds();
        if (jobIds.length === 0) {
          return 'No cron jobs have notes yet.';
        }

        const lines = jobIds.map((id) => {
          const job = cronStore.getJob(id);
          const label = job ? `${id} (${job.name})` : id;
          const count = notesStore.read(id).entries.length;
          return `  ${label}: ${pluralizeEntries(count)}`;
        });

        return `Jobs with notes:\n${lines.join('\n')}`;
      },
    }),

    cron_notes_view: tool({
      description:
        'View a cron job\'s persistent notes formatted for human reading (one entry per block). Prefer cron_notes_read for programmatic consumption.',
      parameters: z.object({
        job_id: z.string().describe('Job ID to view notes for'),
      }),
      execute: async ({ job_id }): Promise<string> => {
        debugLog('cron_notes_view:execute', { job_id });

        const notes = notesStore.read(job_id);
        if (notes.entries.length === 0) {
          return `No notes recorded for job "${job_id}".`;
        }

        const job = cronStore.getJob(job_id);
        const header = job
          ? `Notes for "${job.name}" (${job_id}) — ${pluralizeEntries(notes.entries.length)}`
          : `Notes for job ${job_id} — ${pluralizeEntries(notes.entries.length)}`;
        const body = notes.entries.map(formatEntryView).join('\n\n');
        return `${header}\n\n${body}`;
      },
    }),
  };
}
