import { WorkQueue } from './work-queue.js';
import { RECALL_QUEUE_DIR } from './paths.js';
import type { ReasoningLogEntry } from './reasoning-log.js';

/**
 * The dispatches waiting to be learned from (#501).
 *
 * **Its own leaf module**, not a member of `specialist-recall.ts`, for the reason
 * #529 recorded about `tools/memory.ts`: that module owns a `generateText` call
 * and therefore `model-policy` and the provider graph, and the two producers here
 * sit on the dispatch return path. A leaf importing only the queue, `paths` and a
 * type keeps that edge out of `tools/index.ts`'s eager graph.
 *
 * **The payload is `ReasoningLogEntry`** rather than a new shape. It already
 * carries everything `renderRun` consumes, it is already bounded field-by-field
 * by `reasoning-log.ts`'s own `bounded()`, and reusing it means the queue and the
 * log cannot disagree about what a dispatch was.
 *
 * Memoised because both producers call this per dispatch and the constructor
 * resolves paths; the queue itself holds no state beyond its options.
 */
let queue: WorkQueue<ReasoningLogEntry> | undefined;

/** Whether a parsed payload is something this build can still render. */
function isReasoningLogEntry(value: unknown): value is ReasoningLogEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as ReasoningLogEntry;
  return typeof e.specialistId === 'string' && Array.isArray(e.toolCalls);
}

export function recallQueue(): WorkQueue<ReasoningLogEntry> {
  queue ??= new WorkQueue<ReasoningLogEntry>({
    dir: RECALL_QUEUE_DIR,
    validate: isReasoningLogEntry,
    // Generous against a real install — the busiest five-minute window measured
    // 52 dispatches — but it is a bound on disk for a user who never exits
    // cleanly, so it exists.
    maxPending: 500,
  });
  return queue;
}

/** Drops the memoised queue, for tests that re-point `BERNARD_HOME`. */
export function _resetRecallQueue(): void {
  queue = undefined;
}
