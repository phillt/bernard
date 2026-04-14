import * as fs from 'node:fs';
import { LOGS_DIR, TOOL_WRAPPER_LOG } from './paths.js';

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
  status: 'ok' | 'error' | 'parse_failed';
  error?: string;
  reasoning?: string[];
  /** Session id if available (short identifier to correlate related runs). */
  sessionId?: string;
}

/**
 * Appends one entry to the reasoning log. Never throws — logging must not
 * break the hot path.
 */
let logsDirReady = false;

export function appendReasoningLog(entry: ReasoningLogEntry): void {
  try {
    if (!logsDirReady) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      logsDirReady = true;
    }
    fs.appendFileSync(TOOL_WRAPPER_LOG, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // best-effort; swallow
  }
}

/**
 * Reads and parses the reasoning log, returning the most recent `limit` entries.
 * Skips malformed lines.
 */
export function readReasoningLog(limit = 100): ReasoningLogEntry[] {
  try {
    if (!fs.existsSync(TOOL_WRAPPER_LOG)) return [];
    const contents = fs.readFileSync(TOOL_WRAPPER_LOG, 'utf-8');
    const lines = contents.split('\n').filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit);
    const entries: ReasoningLogEntry[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line) as ReasoningLogEntry);
      } catch {
        /* skip */
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/** Trims the reasoning log to the last `keep` entries. Used for maintenance. */
export function rotateReasoningLog(keep = 1000): void {
  try {
    if (!fs.existsSync(TOOL_WRAPPER_LOG)) return;
    const contents = fs.readFileSync(TOOL_WRAPPER_LOG, 'utf-8');
    const lines = contents.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length <= keep) return;
    const tail = lines.slice(-keep);
    const tmp = TOOL_WRAPPER_LOG + '.tmp';
    fs.writeFileSync(tmp, tail.join('\n') + '\n', 'utf-8');
    fs.renameSync(tmp, TOOL_WRAPPER_LOG);
  } catch {
    /* best-effort */
  }
}

