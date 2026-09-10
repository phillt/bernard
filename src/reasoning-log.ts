import { TOOL_WRAPPER_LOG } from './paths.js';
import { appendJsonlBounded, readJsonlTail, rotateJsonlByCount } from './jsonl.js';
import { truncate } from './text.js';
import { debugLog } from './logger.js';
import { boundValue } from './framework/tools/redact.js';
import { recallQueue } from './recall-queue.js';
import type { ToolErrorType } from './framework/tools/types.js';

/**
 * One entry per `tool_wrapper_run` invocation. Appended as a JSONL line to
 * {@link TOOL_WRAPPER_LOG} by {@link recordDispatch}, which also puts the same
 * entry on the recall queue. The log is append-only, bounded by count and
 * user-readable; it exists so a run can be inspected or replayed. It is NOT where
 * work comes from — corrections and specialist recall both read their own queue,
 * because one append-only file cannot say which of N items a pass has finished.
 */
export interface ReasoningLogEntry {
  ts: string;
  specialistId: string;
  input: string;
  toolCalls: Array<{ tool: string; args: unknown; resultPreview: string }>;
  /**
   * How many earlier tool calls were dropped to fit {@link TOOL_CALLS_MAX}.
   *
   * Absent when nothing was dropped, so an entry that says nothing is complete.
   */
  droppedToolCalls?: number;
  finalOutput: unknown;
  /**
   * `'ok'`, or the `WrapperResult.error` label when there is one — normally a
   * {@link ToolErrorType} such as `parse_failed` or `step_limit`, but typed
   * `string` because that field is written by the model and is not constrained.
   */
  status: 'ok' | 'error' | ToolErrorType | (string & {});
  error?: string;
  reasoning?: string[];
  /** Session id if available (short identifier to correlate related runs). */
  sessionId?: string;
}

/**
 * Rows retained. The budget `apps/invoke.ts` and `apps/capability-log.ts` both
 * use for their own logs, and the same reason: rotation belongs to the WRITER,
 * so a reader only ever selects and formats.
 */
const REASONING_LOG_KEEP = 2000;

/**
 * Per-field cap, because the row budget is a COUNT.
 *
 * `apps/invoke.ts` states it: without one, a single stack trace dwarfs the 2,000
 * rows around it. A count budget is only honest if EVERY field is capped, and
 * the first cut capped four of five — it left `toolCalls[].args` out on the
 * argument that the renderer bounds it, which is a *prompt* bound and not a disk
 * one. Measured on the real log, `args` and `resultPreview` are where the mass
 * is: the largest single `args` is a 15.7 KB `shell` invocation, and a
 * `file_write` carries a whole file. `resultPreview` really is capped upstream
 * by `previewOfResult`; `args` was not capped anywhere.
 */
const FIELD_MAX = 2000;

/**
 * How many tool calls one entry keeps.
 *
 * The file's own rule is that a count budget is only honest if EVERY field is
 * capped, and this was the field it missed: `input`, `finalOutput` and each
 * `args` are bounded, while `toolCalls.length` was not — so one entry is
 * `2 × FIELD_MAX` plus ~540 characters per call, unbounded, against a 150-step
 * ceiling. That is what let a single dispatch render past
 * `RECALL_TRANSCRIPT_MAX` (12,000) at roughly 25 calls and starve its own queue.
 *
 * 12 keeps a maximal entry near 10.6k, so one always fits the recall budget with
 * room for the header. The **tail** is kept rather than the head: this log exists
 * so a failure can be inspected, and the call that failed is the last one.
 */
const TOOL_CALLS_MAX = 12;

/**
 * The same entry with every unbounded field capped.
 *
 * `boundValue` for the two fields of unknown shape — `finalOutput` is a whole
 * dispatch's answer and `args` is whatever a model passed — so a value that fits
 * keeps its structure and stays replayable while an over-budget one comes back
 * as a marked string. `truncate` for the three that are declared `string`.
 */
function bounded(entry: ReasoningLogEntry): ReasoningLogEntry {
  const calls = entry.toolCalls.slice(-TOOL_CALLS_MAX).map((c) => ({
    ...c,
    args: boundValue(c.args, FIELD_MAX),
  }));
  const dropped = entry.toolCalls.length - calls.length;
  return {
    ...entry,
    input: truncate(entry.input, FIELD_MAX),
    finalOutput: boundValue(entry.finalOutput, FIELD_MAX),
    toolCalls: calls,
    // Marked rather than silently short, the `truncateResult` rule: a clipped
    // list still reads as the whole story otherwise.
    ...(dropped > 0 ? { droppedToolCalls: dropped } : {}),
    ...(entry.error ? { error: truncate(entry.error, FIELD_MAX) } : {}),
    ...(entry.reasoning ? { reasoning: entry.reasoning.map((r) => truncate(r, FIELD_MAX)) } : {}),
  };
}

/**
 * Records one dispatch: to the log, and onto the recall queue.
 *
 * **The only writer.** It briefly had a sibling, `appendReasoningLog`, which
 * wrote the log alone and re-stated this function's append line — and had no
 * production caller anywhere in the tree, only tests, so the covered path was not
 * the taken one. One writer rather than two, because the pair is the thing that
 * has to stay together: a dispatch in the log and not in the queue is one a
 * specialist never learns from, silently, which is the class of bug the queue
 * replaces.
 *
 * **Never throws** — logging must not break the hot path. `enqueue` holds the
 * same rule and returns `null` instead.
 *
 * **Bounded on append**, which nothing did before: `rotateReasoningLog` had no
 * production caller either, so this file grew without bound (6.7 MB / 2,354
 * entries on a real install) and every consumer paid for it, since `readJsonlTail`
 * reads the whole file before slicing. Through `appendJsonlBounded` rather than a
 * hand-paired append + rotate: the naive pairing measured **25.7 ms per append**
 * on that log, synchronously, on the return path of every dispatch, because
 * rotation pins the file at exactly the size that forces a full rewrite next time.
 *
 * The log is not a queue and the queue is not a log: the log is the human/replay
 * record, bounded by count and rotated; the queue is in-flight work, bounded by
 * count and emptied by a pass. Neither is derived from the other, and `bounded()`
 * runs once so both see the same entry.
 */
export function recordDispatch(entry: ReasoningLogEntry): void {
  const capped = bounded(entry);
  appendJsonlBounded(TOOL_WRAPPER_LOG, capped, REASONING_LOG_KEEP);
  // **The producer half is at-most-once, and it says so.** `enqueue` returns
  // `null` when the queue is at its cap or the write failed, and there is nothing
  // actionable to do here — but dropping it silently makes the queue's "the set of
  // work is exactly the files present" quietly mean "except the ones we declined
  // to write", with the NEWEST dispatches being the ones lost, since `enqueue`
  // refuses rather than evicts. The predecessor had a signal for exactly this
  // (`specialist-recall:window-truncated`) and this replaced it with an ignored
  // return value.
  if (recallQueue().enqueue(capped) === null) {
    debugLog('specialist-recall:enqueue-dropped', { specialistId: capped.specialistId });
  }
}

/** Reads and parses the reasoning log, returning the most recent `limit` entries. */
export function readReasoningLog(limit = 100): ReasoningLogEntry[] {
  return readJsonlTail<ReasoningLogEntry>(TOOL_WRAPPER_LOG, limit);
}

/** Trims the reasoning log to the last `keep` entries. Used for maintenance. */
export function rotateReasoningLog(keep = REASONING_LOG_KEEP): void {
  rotateJsonlByCount(TOOL_WRAPPER_LOG, keep);
}
