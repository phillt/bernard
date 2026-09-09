import { MemoryStore } from './memory.js';
import { SpecialistStore } from './specialists.js';
import { debugLog } from './logger.js';

/**
 * Deleting a specialist, across every store keyed by its id.
 *
 * Its own module rather than a method on `SpecialistStore`, for the reason
 * `apps/lifecycle.ts` gives about `AppRegistry`: the store owns the record, and
 * this owns the fact that a specialist is spread over more than one place.
 * Putting it on the store would give it an edge to `MemoryStore` to do a job
 * that is not record work.
 *
 * ## Why this became mandatory rather than tidy
 *
 * Before memories were owned, a deleted specialist left nothing worth sweeping.
 * Now its notes carry `owner: <id>`, and `ownsOrShared` is false for every view
 * once that id no longer resolves — so they are **unreadable, un-listable, and
 * un-deletable through any surface**, while still occupying disk and still
 * colliding on write. The only place one ever surfaces is the
 * `MemoryOwnerCollisionError` a later write happens to trip. That is strictly
 * worse than the shared pool that preceded ownership, so the sweep ships with
 * it.
 *
 * ## Re-creating an id, which is the case that decided the scope
 *
 * `createFull` refuses only on `exists(id)` and consults nothing else, so
 * without this a deleted-then-recreated specialist **inherits the previous
 * one's private memories** — same id, same `owner` string, same files. The
 * applet precedent deliberately keeps ONE thing across a delete (the port,
 * because a re-added applet gets back browser storage Bernard cannot recreate).
 * Nothing keyed to a specialist has that property: every row is Bernard's own,
 * so nothing is deliberately kept and "delete means delete" holds without an
 * exception to record.
 *
 * ## Deliberately not swept, and why
 *
 * Correction candidates, the reasoning log and session telemetry all carry the
 * id in a FIELD of an append-only or per-session file, with no index — sweeping
 * them means rewriting logs rather than unlinking a row. They are bounded by
 * their own rotation, and a stale line in a log is inert. The one that is not
 * inert is a pending correction candidate, which would commit examples onto a
 * re-created specialist of the same id; that is recorded on the issue rather
 * than fixed here, because the fix is an index those stores do not have.
 */
export interface DeleteSpecialistResult {
  deleted: boolean;
  /** Memories that went with it. */
  memories: number;
}

export function deleteSpecialist(
  id: string,
  stores?: { specialists?: SpecialistStore; memory?: MemoryStore },
): DeleteSpecialistResult {
  const specialists = stores?.specialists ?? new SpecialistStore({ seed: false });

  // The record first, so the id stops resolving before anything keyed on it is
  // touched — and because this is the step that can REFUSE. `delete` throws
  // `ProtectedSpecialistError` for a bundled record, and sweeping a bundled
  // specialist's memories before discovering it cannot be deleted would destroy
  // data for a record that then stays on disk.
  const deleted = specialists.delete(id);
  if (!deleted) return { deleted: false, memories: 0 };

  let memories = 0;
  try {
    // Unscoped and unowned: `deleteByOwner` reads past both fences, which it
    // must, because these are exactly the records no view can see.
    memories = (stores?.memory ?? new MemoryStore()).deleteByOwner(id);
  } catch (err) {
    // The record is already gone, so a failure here must not throw: it would
    // report a delete that DID happen as a failure, and the caller cannot
    // resume a half-finished sweep. `deleteApplet` swallows its own bound-
    // specialist row for the same reason.
    debugLog('specialist:memory-sweep-failed', {
      specialistId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  debugLog('specialist:deleted', { specialistId: id, memories });
  return { deleted: true, memories };
}
