import * as fs from 'node:fs';
import * as path from 'node:path';
import { CRON_NOTES_DIR } from '../paths.js';
import { atomicWriteFileSync } from '../fs-utils.js';
import { sanitizeKey } from '../memory.js';

const MAX_ENTRIES = 100;

/** Maximum characters per note entry (enforced by writers). */
export const MAX_NOTE_LENGTH = 1000;

/** A single persistent note entry for a cron job. */
export interface CronNoteEntry {
  timestamp: string;
  runId?: string;
  text: string;
}

/** On-disk shape of a cron job's notes file. */
export interface CronNotes {
  jobId: string;
  entries: CronNoteEntry[];
}

/**
 * Per-job persistent note store. Each job's notes live in their own JSON file
 * under {@link CRON_NOTES_DIR} and survive daemon restarts. Entries are
 * append-only with a bounded cap of {@link MAX_ENTRIES} (oldest dropped first).
 */
export class CronNotesStore {
  constructor() {
    fs.mkdirSync(CRON_NOTES_DIR, { recursive: true });
  }

  static get notesDir(): string {
    return CRON_NOTES_DIR;
  }

  private sanitizeJobId(jobId: string): string {
    const cleaned = sanitizeKey(jobId);
    if (!cleaned) throw new Error(`Invalid jobId: ${JSON.stringify(jobId)}`);
    return cleaned;
  }

  private notesPath(jobId: string): string {
    return path.join(CRON_NOTES_DIR, `${this.sanitizeJobId(jobId)}.json`);
  }

  /** Reads all note entries for a job. Returns an empty record if no file exists. */
  read(jobId: string): CronNotes {
    const safeId = this.sanitizeJobId(jobId);
    const filePath = this.notesPath(safeId);
    if (!fs.existsSync(filePath)) return { jobId: safeId, entries: [] };

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as CronNotes;
      return {
        jobId: parsed.jobId ?? safeId,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch {
      return { jobId: safeId, entries: [] };
    }
  }

  /** Appends a note entry, capping at {@link MAX_ENTRIES} (oldest dropped). */
  append(jobId: string, text: string, runId?: string): CronNoteEntry {
    const safeId = this.sanitizeJobId(jobId);
    const current = this.read(safeId);
    const entry: CronNoteEntry = {
      timestamp: new Date().toISOString(),
      text,
      ...(runId ? { runId } : {}),
    };
    const nextEntries = [...current.entries, entry].slice(-MAX_ENTRIES);
    const payload: CronNotes = { jobId: safeId, entries: nextEntries };
    atomicWriteFileSync(this.notesPath(safeId), JSON.stringify(payload, null, 2));
    return entry;
  }

  /** Lists job IDs that have notes files on disk. */
  listJobIds(): string[] {
    if (!fs.existsSync(CRON_NOTES_DIR)) return [];
    return fs
      .readdirSync(CRON_NOTES_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  /** Deletes the notes file for a job. Returns `false` if nothing existed. */
  clear(jobId: string): boolean {
    const filePath = this.notesPath(jobId);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  /** Returns only entries tagged with the given runId. */
  entriesForRun(jobId: string, runId: string): CronNoteEntry[] {
    return this.read(jobId).entries.filter((e) => e.runId === runId);
  }
}
