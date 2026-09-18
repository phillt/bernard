import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  atomicRemoveDirectorySync,
  listSubdirectories,
  pruneSubdirectoriesByAge,
} from './fs-utils.js';
import { WORKSPACES_DIR, WORKSPACE_MAX_AGE_MS, runWorkspace } from './paths.js';

/**
 * The lifecycle of the run workspaces (#585) — creation, retention, removal.
 *
 * `paths.ts` owns the layout and the bound; this owns what happens to what lands
 * there. Until now nothing did: `WORKSPACES_DIR` appeared in exactly one file,
 * every unattended writer that ever ran left a directory behind, and cron
 * writers run on a schedule forever.
 *
 * **Retention is applied here, not from `index.ts`, and that is the shape rather
 * than a preference.** `work-queue.ts` records what the other arrangement costs:
 * the predecessor swept from `index.ts`, one line got written for the recall
 * queue, and the correction queue — the one whose 54 measured rows are half the
 * reason that module exists — was never swept at all. Retention is a property of
 * the thing being retained, so the thing applies it, and a third producer of
 * workspaces cannot silently get none.
 *
 * It hangs off **both** entry points — {@link ensureRunWorkspace} and
 * {@link removeRunWorkspace} — for the reason `WorkQueue.ensureSwept` hangs off
 * both `enqueue` and `peek`: the sweeper has to be on the same path as the
 * grower, and a process that only ever deletes should still bound what it can
 * see. A process that does neither does not sweep, which is correct — it is not
 * a process that grows the directory. The one residual is an install whose every
 * cron job sets `skipPermissions` (which dissolves the write scope, so no
 * workspace is created) and which never deletes a job either: its historical
 * orphans stay. Stated rather than chased, because that install is also not
 * accumulating any new ones.
 *
 * **A timestamp, not a boolean**, again following `WorkQueue.ensureSwept`: the
 * cron daemon and the applet host hold a process open for days, and a
 * once-per-process latch would mean nothing ages out for the whole life of
 * exactly the two processes that produce the most workspaces.
 */

/** How often a long-lived process re-applies retention. See {@link ensureSwept}. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let sweptAt = 0;

/**
 * Retention, at most hourly per process.
 *
 * Cheap enough not to need a budget: two namespaces, at most 50 cron jobs plus a
 * handful of applets, so a `readdir` per namespace and a `stat` per workspace —
 * against a `runHeadless` whose MCP connect alone measures 1.1-1.6 s.
 */
function ensureSwept(): void {
  const now = Date.now();
  if (now - sweptAt < SWEEP_INTERVAL_MS) return;
  sweptAt = now;
  pruneRunWorkspaces(now);
}

/**
 * Makes a run's workspace exist, and marks it as used now.
 *
 * Returns a message when the directory could not be created, so `runHeadless`
 * can log it, and `null` otherwise. It never throws: a run whose workspace is
 * missing fails later with a real filesystem error from the tool that wanted it,
 * which says more than anything this could report.
 *
 * **The stamp is what makes the age bound honest.** A directory's mtime moves
 * when an entry is added to it, so without the stamp "age" would mean "time
 * since the last file landed directly in here" — and a job that writes its
 * output once and then reads it back on every later run would have that output
 * reclaimed while the job was still live. `utimesSync` makes it mean "time since
 * a run was last handed this workspace", which is the fact the bound is about.
 * A failed stamp is not a failed run; the worst case is that the workspace is
 * reclaimed earlier than it should be.
 *
 * **The stamp happens before the sweep, and the order is load-bearing.** A
 * dormant workspace being picked up again is, at the moment it is picked up,
 * older than the bound — so sweeping first would delete the very output the run
 * is re-using, then hand it a fresh empty directory, silently. Stamping first
 * removes that case by construction rather than by an exclusion the next editor
 * can drop.
 */
export function ensureRunWorkspace(workspace: string): string | null {
  let error: string | null = null;
  try {
    fs.mkdirSync(workspace, { recursive: true });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  if (!error) {
    try {
      const now = new Date();
      fs.utimesSync(workspace, now, now);
    } catch {
      // See above: an unstamped workspace ages from its last write instead of
      // from this run. Not worth failing a run over.
    }
  }
  ensureSwept();
  return error;
}

/**
 * Removes the workspace belonging to one owner, when that owner is deleted.
 *
 * Takes the namespace and id rather than a path because it is a recursive
 * delete and the id reaches it from a caller's argument — a cron job id comes
 * off a model's `cron {action:'delete'}` call. `path.join` resolves `..`, so
 * `runWorkspace('cron', '../../memory')` names a real directory outside the
 * workspaces root; nothing currently supplies such an id (cron ids are UUIDs,
 * app ids are schema-validated), and that is exactly the kind of thing that
 * stops being true quietly. Both segments are checked instead.
 */
export function removeRunWorkspace(namespace: string, id: string): void {
  if (isPathSegment(namespace) && isPathSegment(id)) {
    atomicRemoveDirectorySync(runWorkspace(namespace, id));
  }
  ensureSwept();
}

/**
 * The age sweep over the whole workspaces tree.
 *
 * Two levels, matching {@link runWorkspace}'s layout exactly: namespaces, then
 * the workspaces inside them. Namespaces themselves are structural and are never
 * aged out — an empty `workspaces/cron/` is not what #585 is about, and removing
 * it would only mean recreating it on the next run.
 *
 * Exported so a test can drive it directly; production reaches it through
 * {@link ensureSwept}.
 */
export function pruneRunWorkspaces(now: number = Date.now()): void {
  for (const namespace of listSubdirectories(WORKSPACES_DIR)) {
    pruneSubdirectoriesByAge(path.join(WORKSPACES_DIR, namespace), WORKSPACE_MAX_AGE_MS, now);
  }
}

/** One path component, and nothing that could climb out of its parent. */
function isPathSegment(s: string): boolean {
  return (
    s.length > 0 &&
    s !== '.' &&
    s !== '..' &&
    !s.includes('/') &&
    !s.includes('\\') &&
    !s.includes('\0')
  );
}
