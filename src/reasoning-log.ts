import { TOOL_WRAPPER_LOG } from './paths.js';
import { appendJsonl, readJsonlSince, readJsonlTail, rotateJsonlByCount } from './jsonl.js';
import { truncate } from './text.js';
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
 * `apps/invoke.ts` states it: without one, a single stack trace dwarfs the
 * 2,000 rows around it. `input`, `finalOutput`, `error` and each `reasoning`
 * line were all unbounded here — and `finalOutput` is a whole dispatch's answer.
 * `toolCalls[].resultPreview` is already capped by `previewOfResult` upstream;
 * `args` is bounded by the renderer that reads it rather than here, since a
 * structured value is worth keeping structured on disk.
 */
const FIELD_MAX = 2000;

/** The same entry with its unbounded text fields capped. */
function bounded(entry: ReasoningLogEntry): ReasoningLogEntry {
  return {
    ...entry,
    input: truncate(entry.input, FIELD_MAX),
    finalOutput:
      typeof entry.finalOutput === 'string'
        ? truncate(entry.finalOutput, FIELD_MAX)
        : entry.finalOutput,
    ...(entry.error ? { error: truncate(entry.error, FIELD_MAX) } : {}),
    ...(entry.reasoning ? { reasoning: entry.reasoning.map((r) => truncate(r, FIELD_MAX)) } : {}),
  };
}

/**
 * Appends one entry to the reasoning log. Never throws — logging must not break
 * the hot path.
 *
 * **Rotates on every append**, which nothing did before: `rotateReasoningLog`
 * had no production caller anywhere in the tree, so this file grew without
 * bound (6.7 MB / 2,354 entries on a real install) — and every consumer paid for
 * that, since `readJsonlTail` reads the whole file before slicing.
 */
export function appendReasoningLog(entry: ReasoningLogEntry): void {
  try {
    appendJsonl(TOOL_WRAPPER_LOG, bounded(entry));
    rotateJsonlByCount(TOOL_WRAPPER_LOG, REASONING_LOG_KEEP);
  } catch {
    // The log must never take down the dispatch it is recording.
  }
}

/** Reads and parses the reasoning log, returning the most recent `limit` entries. */
export function readReasoningLog(limit = 100): ReasoningLogEntry[] {
  return readJsonlTail<ReasoningLogEntry>(TOOL_WRAPPER_LOG, limit);
}

/**
 * Every entry written after `cursorMs`, oldest-first.
 *
 * The reader a consumer with a marker wants, in place of a fixed-size tail: see
 * {@link readJsonlSince} for why the two are not interchangeable. An entry whose
 * `ts` will not parse is KEPT rather than treated as old, so a malformed
 * timestamp costs a re-read and never a lost dispatch.
 */
export function readReasoningLogSince(cursorMs: number): ReasoningLogEntry[] {
  return readJsonlSince<ReasoningLogEntry>(TOOL_WRAPPER_LOG, (e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t <= cursorMs;
  });
}

/** Trims the reasoning log to the last `keep` entries. Used for maintenance. */
export function rotateReasoningLog(keep = REASONING_LOG_KEEP): void {
  rotateJsonlByCount(TOOL_WRAPPER_LOG, keep);
}
