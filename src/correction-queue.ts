import { WorkQueue } from './work-queue.js';
import { CORRECTION_QUEUE_DIR } from './paths.js';
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
  queue ??= new WorkQueue<CorrectionWork>({
    dir: CORRECTION_QUEUE_DIR,
    validate: isCorrectionWork,
    // `MAX_PENDING_CORRECTIONS`'s value, now a bound on the whole directory
    // rather than on one status — which is what makes it a real bound.
    maxPending: 50,
  });
  return queue;
}

/** Drops the memoised queue, for tests that re-point `BERNARD_HOME`. */
export function _resetCorrectionQueue(): void {
  queue = undefined;
}
