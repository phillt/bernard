import { tool } from 'ai';
import { z } from 'zod';
import { CronNotesStore, MAX_NOTE_LENGTH, type CronNoteEntry } from '../cron/notes-store.js';
import { CronStore } from '../cron/store.js';
import { debugLog } from '../logger.js';
import { missing } from './cron.js';
import { attachActionMeta } from '../framework/tools/adapter.js';

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

/** Note actions that only read. `write` is the sole mutator. */
export const CRON_NOTES_READ_ACTIONS: ReadonlySet<string> = new Set(['read', 'list', 'view']);

interface CronNotesArgs {
  action: CronNotesAction;
  job_id?: string;
  text?: string;
}

interface CronNotesDeps {
  notesStore: CronNotesStore;
  cronStore: CronStore;
}

type CronNotesHandler = (deps: CronNotesDeps, args: CronNotesArgs) => Promise<string>;

/** Per-action handlers, exported for direct unit testing (#253). */
export const CRON_NOTES_ACTIONS = {
  read: async ({ notesStore }, { job_id }) => {
    if (!job_id)
      return 'Error: "read" requires `job_id`. Example: {"action":"read","job_id":"<id>"}';
    const notes = notesStore.read(job_id);
    if (notes.entries.length === 0) {
      return `No notes recorded for job "${job_id}".`;
    }
    const lines = notes.entries.map(formatEntryCompact);
    return `Notes for job "${job_id}" (${pluralizeEntries(notes.entries.length)}):\n${lines.join('\n')}`;
  },

  write: async ({ notesStore }, { job_id, text }) => {
    if (!job_id || !text) {
      return missing(
        'write',
        'job_id and text',
        '{"action":"write","job_id":"<id>","text":"Sent the report"}',
      );
    }
    if (text.length > MAX_NOTE_LENGTH) {
      return `Error: note text exceeds ${MAX_NOTE_LENGTH} characters (got ${text.length}). Summarize first.`;
    }
    const { total } = notesStore.append(job_id, text);
    return `Appended note to job "${job_id}" (${pluralizeEntries(total)} total).`;
  },

  list: async ({ notesStore, cronStore }) => {
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

  view: async ({ notesStore, cronStore }, { job_id }) => {
    if (!job_id)
      return 'Error: "view" requires `job_id`. Example: {"action":"view","job_id":"<id>"}';
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
} satisfies Record<string, CronNotesHandler>;

export type CronNotesAction = keyof typeof CRON_NOTES_ACTIONS;

/**
 * Derived from the handler table, not declared beside it — a parallel list can
 * drift, and a schema accepting an action with no handler dispatches to
 * `undefined` at call time.
 */
export const CRON_NOTES_ACTION_NAMES = Object.keys(CRON_NOTES_ACTIONS) as [
  CronNotesAction,
  ...CronNotesAction[],
];

/**
 * Consolidated cron-notes tool (#253) — one action-enum tool replacing
 * `cron_notes_read` / `_write` / `_list` / `_view`.
 *
 * In daemon runs these globals are overridden by job-scoped closures in
 * {@link ../cron/runner} that auto-tag writes with the current runId; see
 * `src/cron/scoped-notes-tools.ts` for the self-scoped variants.
 */
export function createCronNotesTool() {
  const deps: CronNotesDeps = { notesStore: new CronNotesStore(), cronStore: new CronStore() };

  return {
    cron_notes: attachActionMeta(
      tool({
        description: `Read and append persistent per-job cron notes. Notes survive daemon restarts and record what prior runs actually did, so a job can avoid repeating work.

Actions: read · write · list · view
  read  — compact entry list for one job (programmatic use); needs job_id
  write — append one short factual entry; needs job_id and text
  list  — every job that has notes, with entry counts
  view  — the same notes formatted for a human to read; needs job_id`,
        parameters: z.object({
          action: z.enum(CRON_NOTES_ACTION_NAMES).describe('The notes operation to perform'),
          job_id: z.string().optional().describe('Job ID — required by read/write/view'),
          text: z
            .string()
            .min(1)
            .max(MAX_NOTE_LENGTH)
            .optional()
            .describe('write: short factual description of the action taken'),
        }),
        execute: async (args): Promise<string> => {
          debugLog('cron_notes:execute', args);
          return CRON_NOTES_ACTIONS[args.action](deps, args);
        },
      }),
      { name: 'cron_notes', readActions: CRON_NOTES_READ_ACTIONS },
    ),
  };
}
