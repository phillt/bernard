import type { CronStore } from './store.js';
import type { CronLogStore } from './log-store.js';
import { CronNotesStore } from './notes-store.js';
import { removeRunWorkspace } from '../workspaces.js';

/**
 * Deleting a cron job, across every store keyed by its id (#585).
 *
 * Its own module rather than a method on `CronStore`, mirroring
 * `src/apps/lifecycle.ts` and for the reason that module's header gives: the
 * store owns `jobs.json` and nothing else, and folding the sweep into
 * `deleteJob` would give a pure filter-and-save an edge to the log store, the
 * notes store and the workspaces tree to do a job that is not store work.
 *
 * It exists because `deleteJob` had **three** callers — the `cron` tool, and
 * `cronDelete` / `cronDeleteAll` in the CLI — and all three paired it only with
 * `deleteJobLogs`. So a deleted job leaked its workspace and its notes from
 * every door, and `CronNotesStore.clear` had no production caller at all. Three
 * copies of a sweep is how one of them ends up a row short; one module is what
 * makes a fourth artifact a single edit.
 *
 * **`CronStore.deleteJob` now has exactly one caller in the tree — this one —
 * and that is what makes the sweep unbypassable rather than merely applied.** A
 * module every caller happens to use today is a convention; a method with one
 * caller is a property, and it is the property worth preserving: a fifth door
 * that wants to drop a job has to come through here. `saveJobs` is public and
 * could in principle write a shorter array, but `deleteJob` is the only
 * filter-and-save that drops a row, so there is no store-layer bypass today.
 */

/**
 * The stores to sweep. **Required, not defaulted**, unlike `deleteApplet`'s
 * self-constructed registry: all three call sites already hold both, so a
 * fallback would only ever mean a second `CronStore()` constructing directories
 * and writing `jobs.json` beside the instance the caller is already using.
 */
export interface CronDeleteDeps {
  store: CronStore;
  logStore: CronLogStore;
}

/**
 * Removes a cron job and everything keyed to it.
 *
 * Returns whether the `jobs.json` row existed, which the `cron` tool needs to
 * say "no job found". **The artifacts are swept either way**, and that is
 * deliberate rather than sloppy: every install that predates this has orphaned
 * workspaces and notes from jobs whose rows are long gone, and a sweep gated on
 * the row can never reach them. There is nothing to get wrong — an absent
 * directory and an absent notes file are both no-ops.
 *
 * Unlike `deleteApplet` the order is unconstrained: nothing here is held open by
 * another process the way a served applet's SQLite connection is. The daemon
 * re-reads `jobs.json` on its own `fs.watch`, and a job it is mid-run on holds
 * no handle on the notes file or the workspace between writes.
 */
export function deleteCronJob(id: string, deps: CronDeleteDeps): boolean {
  const existed = deps.store.deleteJob(id);
  deps.logStore.deleteJobLogs(id);
  try {
    new CronNotesStore().clear(id);
  } catch {
    // `clear` throws for an id that sanitizes to nothing — a shape no job
    // record can have, but `id` reaches the tool path straight off a model's
    // call. Nothing to clean up in that case, and nothing a caller can do.
  }
  removeRunWorkspace('cron', id);
  return existed;
}
