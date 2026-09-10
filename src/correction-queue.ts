import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkQueue } from './work-queue.js';
import { CORRECTION_QUEUE_DIR, DATA_DIR } from './paths.js';
import { debugLog } from './logger.js';
import type { ToolErrorType } from './framework/tools/types.js';

/**
 * Failed tool-wrapper invocations waiting for the correction agent.
 *
 * Was `CorrectionCandidateStore`, a per-item store with the three defects a
 * queue exists to prevent:
 *
 * - **No retry.** A provider timeout or an exhausted pool was written as
 *   `invalid` and never looked at again — an environmental failure recorded as a
 *   verdict on the candidate.
 * - **No retention.** `pruneOld` existed on two of the four candidate stores and
 *   not this one, so terminal rows accumulated for the life of the install — 54
 *   on a real install, and every `listPending()` read and parsed all of them.
 * - **Newest-first.** `list()` sorted descending and the drain took the first
 *   five, so with six pending the oldest starved permanently.
 *
 * The queue fixes all three by construction, and the four terminal statuses go
 * with it: `applied` is durable on the specialist record, `dismissed` was only
 * ever set by a function with no production caller, and `rejected`/`invalid` are
 * what `parked/` is for — bounded, inspectable, and not in the working set.
 */
export interface CorrectionWork {
  specialistId: string;
  input: string;
  /** Stringified tool call that failed (best-effort capture). */
  attemptedCall: string;
  error: string;
  /** Failure taxonomy category, set at enqueue time when known. */
  category?: ToolErrorType;
}

/** What the drain takes in one pass. Was `MAX_CANDIDATES_PER_RUN`. */
export const MAX_CORRECTIONS_PER_RUN = 5;

let queue: WorkQueue<CorrectionWork> | undefined;

function isCorrectionWork(value: unknown): value is CorrectionWork {
  if (!value || typeof value !== 'object') return false;
  const w = value as CorrectionWork;
  return (
    typeof w.specialistId === 'string' && typeof w.input === 'string' && typeof w.error === 'string'
  );
}

export function correctionQueue(): WorkQueue<CorrectionWork> {
  if (!queue) {
    queue = new WorkQueue<CorrectionWork>({
      dir: CORRECTION_QUEUE_DIR,
      validate: isCorrectionWork,
      // `MAX_PENDING_CORRECTIONS`'s value, now a bound on the whole directory
      // rather than on one status — which is what makes it a real bound.
      maxPending: 50,
    });
    migrateLegacyCandidates(queue);
  }
  return queue;
}

/** Where `CorrectionCandidateStore` kept its rows, before the queue replaced it. */
const LEGACY_DIR = path.join(DATA_DIR, 'correction-candidates');

/**
 * Moves the predecessor store's PENDING rows onto the queue, then removes it.
 *
 * The rows are not all terminal. `CorrectionCandidateStore` held
 * `status: 'pending'` items — real queued work — beside the 54 finished ones
 * measured on a real install, so deleting the directory outright loses learning
 * the user had already earned. Ten lines is the difference between a documented
 * one-session gap (which the recall side genuinely has, because a queue cannot
 * be back-filled from a log it no longer reads) and an undocumented one here.
 *
 * **In this module, not at a REPL startup call site**, and that is the half worth
 * keeping: it runs from the memoised getter, so a cron-only or `bernard script`
 * install migrates and cleans up on its first correction rather than keeping the
 * directory forever. It is also where the old shape is already known.
 *
 * Best-effort and silent on failure. A directory that cannot be read is left
 * exactly where it is — the one outcome that loses nothing.
 */
function migrateLegacyCandidates(q: WorkQueue<CorrectionWork>): void {
  let entries: fs.Dirent[];
  try {
    if (!fs.statSync(LEGACY_DIR).isDirectory()) return;
    entries = fs.readdirSync(LEGACY_DIR, { withFileTypes: true });
  } catch {
    // Absent (the overwhelmingly common case) or unreadable. Nothing to do.
    return;
  }
  // Refuse anything that is not shaped like the store we are replacing, rather
  // than `rmSync` a path we only believe is ours. This can never be undone.
  if (entries.some((e) => !e.isFile() || !e.name.endsWith('.json'))) {
    debugLog('correction-queue:legacy-unrecognised', { dir: LEGACY_DIR });
    return;
  }
  let migrated = 0;
  for (const entry of entries) {
    try {
      const row: unknown = JSON.parse(fs.readFileSync(path.join(LEGACY_DIR, entry.name), 'utf-8'));
      if (!row || typeof row !== 'object') continue;
      const r = row as { status?: unknown } & Partial<CorrectionWork>;
      if (r.status !== 'pending') continue;
      if (!isCorrectionWork(r)) continue;
      if (
        q.enqueue({
          specialistId: r.specialistId,
          input: r.input,
          attemptedCall: r.attemptedCall ?? '',
          error: r.error,
          ...(r.category ? { category: r.category } : {}),
        })
      ) {
        migrated++;
      }
    } catch {
      // One unreadable row must not strand the rest, or the directory survives
      // forever because of a single bad file.
    }
  }
  try {
    fs.rmSync(LEGACY_DIR, { recursive: true, force: true });
    debugLog('correction-queue:legacy-migrated', { migrated, rows: entries.length });
  } catch {
    // Left in place; the next process tries again.
  }
}
