import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SESSION_LOGS_DIR } from './paths.js';
import { pruneFileGroupsByMtime } from './jsonl.js';

const MAX_SESSIONS = 50;

/**
 * A session's id as it appears at the head of every file the session writes:
 * `YYYY-MM-DD-<8 hex>`, per {@link getSessionId}. Anchored, so it matches both
 * `<id>.jsonl` and a `<id>-<suffix>` sidecar and nothing else in the directory.
 */
const SESSION_FILE_RE = /^(\d{4}-\d{2}-\d{2}-[0-9a-f]{8})/;

let SESSION_ID: string | null = null;
let dirCreated = false;
let rotated = false;
/** Open sidecar descriptors, keyed by suffix — one per suffix per process. */
const sidecarFds = new Map<string, number>();

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

/** Create the session-log directory once per process. */
function ensureLogDir(): void {
  if (dirCreated) return;
  fs.mkdirSync(SESSION_LOGS_DIR, { recursive: true });
  dirCreated = true;
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

  ensureLogDir();
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
 * Keep the N most recent sessions; delete the rest.
 *
 * Retention is per SESSION, not per file: a session writes its `<id>.jsonl`
 * plus one sidecar per subsystem that needed a descriptor (see
 * {@link openSessionSidecarFd}), and those files are one unit — ranking them
 * individually would let a single run consume several slots, retain a sidecar
 * whose transcript was already deleted, and quietly redefine `MAX_SESSIONS` as
 * a per-extension budget. Grouping also means a new sidecar is covered the day
 * it is added, with no list here to keep in sync.
 */
function rotateSessionLogs(): void {
  pruneFileGroupsByMtime(SESSION_LOGS_DIR, MAX_SESSIONS, (name) => {
    const m = SESSION_FILE_RE.exec(name);
    // Not a session file — leave it alone rather than sweep the directory.
    return m ? m[1] : null;
  });
}

/**
 * An append descriptor for a per-session sidecar file named
 * `<sessionId>-<suffix>`, or `null` when debug logging is off or the file
 * cannot be opened.
 *
 * For output Bernard does not produce and cannot interleave into its own
 * stream: a spawned child's stderr, which has to go *somewhere* that needs no
 * reader draining it (see `mcpStderrTarget` in `src/mcp.ts`). Handing out a
 * descriptor rather than a path is the point — the kernel writes to it
 * directly, so nothing here is on the hot path once it is open.
 *
 * Lives beside {@link debugLog} because the session id, the directory latch
 * and the retention budget are all owned here; a caller that opened its own
 * file would re-derive the naming convention and then have to be remembered
 * separately by {@link rotateSessionLogs}.
 *
 * One descriptor per suffix per process, never closed — it is append-only and
 * released at exit. Note the file is unbounded *within* a session: rotation
 * counts sessions and runs once at startup, so a long-lived daemon with a
 * chatty child accumulates a single large sidecar until it next restarts.
 */
export function openSessionSidecarFd(suffix: string): number | null {
  if (!isDebugEnabled()) return null;
  const open = sidecarFds.get(suffix);
  if (open !== undefined) return open;
  try {
    ensureLogDir();
    const fd = fs.openSync(path.join(SESSION_LOGS_DIR, `${getSessionId()}-${suffix}`), 'a');
    sidecarFds.set(suffix, fd);
    return fd;
  } catch {
    // Never let a logging failure stop the caller's real work.
    return null;
  }
}
