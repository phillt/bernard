import * as fs from 'node:fs';
import * as path from 'node:path';
import { APPLET_BRIEFS_DIR } from '../paths.js';
import { atomicWriteFileSync } from '../fs-utils.js';
import { APP_ID_RE } from './manifest.js';
import {
  MAX_NOTES,
  MAX_NOTE_CHARS,
  emptyBrief,
  normalizeIntent,
  type AppletBrief,
  type BriefNote,
  type IntentField,
} from './brief.js';

/**
 * One design brief per applet, on disk (#463).
 *
 * File layout and atomic writes are `CronNotesStore`'s, which is the precedent
 * the issue names. Two deliberate departures from it:
 *
 * **A bad id is REFUSED, never repaired.** `CronNotesStore` runs `sanitizeKey`
 * and writes to whatever is left. `AppletStore` refuses instead, on the stated
 * grounds that "a repaired id addresses a different store than the caller
 * named" — which is the right rule for anything keyed on an `appId`, since the
 * repaired id may be another applet's.
 *
 * **`clear()` has a caller.** `CronNotesStore.clear()` has none — `deleteJob`
 * never sweeps `CRON_NOTES_DIR` — so the precedent leaks a file per deleted
 * job. `deleteApplet` calls this one, and the existing no-orphans test asserts
 * it.
 *
 * **Known limit:** `atomicWriteFileSync` makes a WRITE atomic, not a
 * read-modify-write, so two concurrent appends would lose one. Stated rather
 * than discovered; the writer is a single REPL turn, and `paths.ts` already
 * records the same caveat for the session registry.
 */
export class AppletBriefStore {
  constructor() {
    fs.mkdirSync(APPLET_BRIEFS_DIR, { recursive: true, mode: 0o700 });
  }

  private briefPath(appId: string): string {
    // Refuse, do not repair: `APP_ID_RE` is the same expression the manifest
    // validates against, so an id this rejects could never name a real applet.
    if (!APP_ID_RE.test(appId)) throw new Error(`Invalid applet id: ${JSON.stringify(appId)}`);
    return path.join(APPLET_BRIEFS_DIR, `${appId}.json`);
  }

  /** Reads a brief. An absent or unreadable file yields an empty one. */
  read(appId: string): AppletBrief {
    const file = this.briefPath(appId);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<AppletBrief>;
      // Re-normalized on the way out even though this store wrote it: the file
      // is plain JSON under `DATA_DIR` and hand-editable between runs, the same
      // time-of-check gap `registry.get` refuses to leave open.
      return {
        intent: normalizeIntent(parsed.intent as Partial<Record<string, string>>),
        notes: Array.isArray(parsed.notes)
          ? parsed.notes.filter(
              (n): n is BriefNote =>
                !!n && typeof n.text === 'string' && typeof n.timestamp === 'string',
            )
          : [],
      };
    } catch (err) {
      // A missing brief is the normal case for every applet built before this
      // existed, and a corrupt one must not take an edit down — the brief is
      // context, not authority.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof SyntaxError) {
        return emptyBrief();
      }
      throw err;
    }
  }

  /**
   * Merges intent fields and/or appends a note. Returns the brief as written.
   *
   * A field set to `''` is removed, which is how a caller corrects a mistake
   * rather than being stuck with it — `normalizeIntent` drops empties, so this
   * is the difference between "not mentioned" (absent from `intent`) and
   * "clear this" (present and empty).
   */
  write(
    appId: string,
    update: { intent?: Partial<Record<string, string>>; note?: string },
    now = new Date(),
  ): AppletBrief {
    const current = this.read(appId);
    const next: AppletBrief = { intent: { ...current.intent }, notes: [...current.notes] };

    if (update.intent) {
      // One pass, not one per key: the caller's key set is what distinguishes
      // "not mentioned" (absent) from "clear this" (present and empty), and
      // `normalizeIntent` drops the latter.
      const cleaned = normalizeIntent(update.intent);
      for (const key of Object.keys(update.intent)) {
        const field = key as IntentField;
        if (cleaned[field] === undefined) delete next.intent[field];
        else next.intent[field] = cleaned[field];
      }
    }

    const note = update.note?.trim();
    if (note) {
      next.notes.push({ timestamp: now.toISOString(), text: note.slice(0, MAX_NOTE_CHARS) });
      // Bounded on DISK too, not only in the render. `renderBrief` surfaces
      // about fifty notes at the default budget, so beyond this every extra
      // note is bytes that are read, re-serialised and then always dropped.
      if (next.notes.length > MAX_NOTES) next.notes = next.notes.slice(-MAX_NOTES);
    }

    atomicWriteFileSync(this.briefPath(appId), JSON.stringify(next, null, 2) + '\n', {
      mode: 0o600,
    });
    return next;
  }

  /** Removes an applet's brief. Called by `deleteApplet`. */
  clear(appId: string): boolean {
    const file = this.briefPath(appId);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  }
}
