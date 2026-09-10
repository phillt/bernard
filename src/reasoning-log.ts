import { TOOL_WRAPPER_LOG } from './paths.js';
import { appendJsonlBounded, readJsonlTail, rotateJsonlByCount } from './jsonl.js';
import { truncate } from './text.js';
import { boundValue } from './framework/tools/redact.js';
import { recallQueue } from './recall-queue.js';
import type { ToolErrorType } from './framework/tools/types.js';

/**
 * One entry per `tool_wrapper_run` invocation. Appended as a JSONL line to
 * {@link TOOL_WRAPPER_LOG}. The log is append-only and user-readable; it
 * exists primarily so failed runs can be inspected, replayed, or converted
 * into correction candidates.
 */
export interface ReasoningLogEntry {
  ts: string;
  specialistId: string;
  input: string;
  toolCalls: Array<{ tool: string; args: unknown; resultPreview: string }>;
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
 * The same entry with every unbounded field capped.
 *
 * `boundValue` for the two fields of unknown shape — `finalOutput` is a whole
 * dispatch's answer and `args` is whatever a model passed — so a value that fits
 * keeps its structure and stays replayable while an over-budget one comes back
 * as a marked string. `truncate` for the three that are declared `string`.
 */
function bounded(entry: ReasoningLogEntry): ReasoningLogEntry {
  return {
    ...entry,
    input: truncate(entry.input, FIELD_MAX),
    finalOutput: boundValue(entry.finalOutput, FIELD_MAX),
    toolCalls: entry.toolCalls.map((c) => ({ ...c, args: boundValue(c.args, FIELD_MAX) })),
    ...(entry.error ? { error: truncate(entry.error, FIELD_MAX) } : {}),
    ...(entry.reasoning ? { reasoning: entry.reasoning.map((r) => truncate(r, FIELD_MAX)) } : {}),
  };
}

/**
 * Appends one entry to the reasoning log. Never throws — logging must not break
 * the hot path.
 *
 * **Bounded on append**, which nothing did before: `rotateReasoningLog` had no
 * production caller anywhere in the tree, so this file grew without bound (6.7 MB
 * / 2,354 entries on a real install) — and every consumer paid for that, since
 * `readJsonlTail` reads the whole file before slicing.
 *
 * Through `appendJsonlBounded` rather than a hand-paired append + rotate: the
 * naive pairing measured **25.7 ms per append** on that log, synchronously, on
 * the return path of every dispatch, because rotation pins the file at exactly
 * the size that forces a full rewrite next time. See that function for the
 * numbers.
 */
export function appendReasoningLog(entry: ReasoningLogEntry): void {
  appendJsonlBounded(TOOL_WRAPPER_LOG, bounded(entry), REASONING_LOG_KEEP);
}

/**
 * Records one dispatch: to the log, and onto the recall queue.
 *
 * One function rather than two calls at each of the two producers, because the
 * pair is the thing that has to stay together — a dispatch in the log and not in
 * the queue is one a specialist never learns from, silently, and that is exactly
 * the class of bug the queue replaces. It also means both sites bound the entry
 * through the same `bounded()` before either consumer sees it.
 *
 * The log is no longer a queue and the queue is not a log: the log is the
 * human/replay record, bounded by count and rotated; the queue is in-flight work,
 * bounded by count and emptied by a pass. Neither is derived from the other.
 */
export function recordDispatch(entry: ReasoningLogEntry): void {
  const capped = bounded(entry);
  appendJsonlBounded(TOOL_WRAPPER_LOG, capped, REASONING_LOG_KEEP);
  recallQueue().enqueue(capped);
}

/** Reads and parses the reasoning log, returning the most recent `limit` entries. */
export function readReasoningLog(limit = 100): ReasoningLogEntry[] {
  return readJsonlTail<ReasoningLogEntry>(TOOL_WRAPPER_LOG, limit);
}

/** Trims the reasoning log to the last `keep` entries. Used for maintenance. */
export function rotateReasoningLog(keep = REASONING_LOG_KEEP): void {
  rotateJsonlByCount(TOOL_WRAPPER_LOG, keep);
}
