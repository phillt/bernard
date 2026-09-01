import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SESSION_LOGS_DIR } from './paths.js';
import { pruneFilesByMtime } from './jsonl.js';

const MAX_SESSION_FILES = 50;

let SESSION_ID: string | null = null;
let dirCreated = false;
let rotated = false;

/** Returns true when BERNARD_DEBUG is on. Central gate — prefer this over inline env reads. */
export function isDebugEnabled(): boolean {
  return process.env.BERNARD_DEBUG === 'true' || process.env.BERNARD_DEBUG === '1';
}

/**
 * Stable per-process session id. Lazily generated on first call as
 * `YYYY-MM-DD-<hex>`. Used to name the per-session debug log under
 * `LOGS_DIR/sessions/` and stamped on every {@link debugLog} record.
 */
export function getSessionId(): string {
  if (SESSION_ID) return SESSION_ID;
  const date = new Date().toISOString().slice(0, 10);
  const rand = crypto.randomBytes(4).toString('hex');
  SESSION_ID = `${date}-${rand}`;
  return SESSION_ID;
}

/** Absolute path to the current session's JSONL log file. */
export function getSessionLogPath(): string {
  return path.join(SESSION_LOGS_DIR, `${getSessionId()}.jsonl`);
}

/**
 * Append a JSONL record to the per-session debug log when `BERNARD_DEBUG`
 * is enabled. No-ops silently when debug mode is off.
 *
 * Each record carries `{ timestamp, sessionId, label, data }` so a single
 * file can be scanned end-to-end to reconstruct everything Bernard did in
 * the session. Hangs show as a last-known-good event followed by silence.
 */
export function debugLog(label: string, data: unknown): void {
  if (!isDebugEnabled()) return;

  if (!dirCreated) {
    fs.mkdirSync(SESSION_LOGS_DIR, { recursive: true });
    dirCreated = true;
  }
  if (!rotated) {
    rotated = true;
    try {
      rotateSessionLogs();
    } catch {
      // best-effort housekeeping; never block a log write on rotation failure
    }
  }

  const sessionId = getSessionId();
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    sessionId,
    label,
    data,
  });
  fs.appendFileSync(getSessionLogPath(), entry + '\n');
}

/**
 * Trace a standalone LLM call (one not already routed through
 * `framework/runner.ts`). Emits `llm:start` / `llm:end` (or `llm:error`)
 * with timing and model id. No-op when debug is off — the wrapped fn runs
 * exactly once either way.
 */
export async function traceLlm<T>(site: string, model: string, fn: () => Promise<T>): Promise<T> {
  if (!isDebugEnabled()) return fn();
  const t0 = Date.now();
  debugLog('llm:start', { site, model });
  try {
    const result = await fn();
    debugLog('llm:end', { site, model, durationMs: Date.now() - t0, ok: true });
    return result;
  } catch (err) {
    debugLog('llm:error', {
      site,
      model,
      durationMs: Date.now() - t0,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Keep the N most recent session logs by mtime; delete the rest.
 *
 * Pruned per extension, not once over the directory: a session that spawns
 * MCP servers drops a sibling `<sessionId>-mcp-stderr.log` beside its
 * `.jsonl`, and a single mixed prune would let a run's two files compete for
 * the same budget — halving the number of sessions actually retained.
 */
function rotateSessionLogs(): void {
  pruneFilesByMtime(SESSION_LOGS_DIR, MAX_SESSION_FILES, '.jsonl');
  pruneFilesByMtime(SESSION_LOGS_DIR, MAX_SESSION_FILES, '.log');
}
