import { TOOL_WRAPPER_LOG } from './paths.js';
import { appendJsonl, readJsonlTail, rotateJsonlByCount } from './jsonl.js';

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
  status: 'ok' | 'error' | 'parse_failed' | 'step_limit';
  error?: string;
  reasoning?: string[];
  /** Session id if available (short identifier to correlate related runs). */
  sessionId?: string;
}

/** Appends one entry to the reasoning log. Never throws — logging must not break the hot path. */
export function appendReasoningLog(entry: ReasoningLogEntry): void {
  appendJsonl(TOOL_WRAPPER_LOG, entry);
}

/** Reads and parses the reasoning log, returning the most recent `limit` entries. */
export function readReasoningLog(limit = 100): ReasoningLogEntry[] {
  return readJsonlTail<ReasoningLogEntry>(TOOL_WRAPPER_LOG, limit);
}

/** Trims the reasoning log to the last `keep` entries. Used for maintenance. */
export function rotateReasoningLog(keep = 1000): void {
  rotateJsonlByCount(TOOL_WRAPPER_LOG, keep);
}
