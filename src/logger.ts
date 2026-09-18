import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SESSION_LOGS_DIR } from './paths.js';
import { pruneFileGroupsByMtime } from './jsonl.js';

const MAX_SESSIONS = 50;

/**
 * Sidecar ceiling, the tail kept when it is crossed, and how often we look.
 *
 * Plain constants, like {@link MAX_SESSIONS} beside them: a ceiling on debug
 * output is not a thing a user tunes, and an env var here would be one more
 * knob nobody sets. The ceiling is a budget rather than a measurement — no
 * install here has produced a large sidecar, which is precisely the point (the
 * process that would is the one nobody watches). Keeping an eighth of the
 * ceiling means a truncation costs one read+write per ~3.5MB the child wrote,
 * while still leaving half a megabyte of context to read after something
 * broke.
 */
const SIDECAR_MAX_BYTES = 4 * 1024 * 1024;
const SIDECAR_KEEP_BYTES = 512 * 1024;
const SIDECAR_CHECK_MS = 30_000;

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
/** Installed on the first sidecar open; see {@link watchSidecars}. */
let sidecarTimer: ReturnType<typeof setInterval> | null = null;

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
 * One descriptor per suffix per process, and deliberately never closed: the
 * child holds it for its whole life, and holding our end is what lets
 * {@link boundSidecar} truncate the file in place. It is released at exit.
 *
 * Opened `a+` rather than `a` for that same reason — `a` is write-only, so the
 * fd could not read back its own tail. The child only ever writes to it, and
 * `O_APPEND` is set either way, so nothing about what the child sees changes.
 *
 * Bounded *within* a session by {@link watchSidecars}; see its note for why
 * rotation alone was not enough and why the check is on a clock.
 */
export function openSessionSidecarFd(suffix: string): number | null {
  if (!isDebugEnabled()) return null;
  const open = sidecarFds.get(suffix);
  if (open !== undefined) return open;
  try {
    ensureLogDir();
    const fd = fs.openSync(path.join(SESSION_LOGS_DIR, `${getSessionId()}-${suffix}`), 'a+');
    sidecarFds.set(suffix, fd);
    watchSidecars();
    return fd;
  } catch {
    // Never let a logging failure stop the caller's real work.
    return null;
  }
}

/**
 * Start the sidecar size check, once per process, on the first successful open.
 *
 * **Why a clock, and not an event.** {@link rotateSessionLogs} bounds how many
 * SESSIONS survive and runs once per process, so a process that never restarts
 * never rotates — the cron daemon and the applet host, which is the population
 * this exists for. Every trigger Bernard could hang the check off instead
 * measures *Bernard's* activity, not the child's: {@link debugLog} would put an
 * `fstatSync` on the highest-frequency logging call in the tree and still go
 * quiet exactly when the child is loudest (a server we have stopped calling
 * because it is broken is the one dumping stack traces), and checking at open
 * covers a daemon's per-run connect churn while missing the REPL shape
 * entirely — one child, held for days. The file is written by a process we do
 * not observe, so the only signal correlated with it growing is the clock.
 *
 * It costs nothing on any hot path: one `fstatSync` per open sidecar per
 * interval, in a process that has both debug on and a spawned stdio child.
 * Installed lazily, so every other process — every CLI subcommand, every test,
 * every debug-off run — never creates the timer at all. `unref`ed, so a missed
 * teardown can never be the reason a process will not exit (the idiom
 * `inbox/watcher.ts` and `watchers/poller.ts` already use).
 */
function watchSidecars(): void {
  if (sidecarTimer) return;
  sidecarTimer = setInterval(() => {
    for (const fd of sidecarFds.values()) boundSidecar(fd);
  }, SIDECAR_CHECK_MS);
  sidecarTimer.unref?.();
}

/**
 * Truncate one sidecar in place, keeping its tail, when it is over budget.
 *
 * **In place is the only option.** The child holds this descriptor in
 * `O_APPEND`, so the tmp+rename that `rotateJsonlByCount` and the cron
 * log store both use would not bound anything: the child keeps writing to the
 * renamed inode, and we would be left rotating a file nobody appends to.
 * `ftruncateSync` is what preserves the descriptor. `O_APPEND` also means the
 * child's next write seeks to the new end rather than to its old offset, so
 * truncating leaves no sparse hole.
 *
 * The **tail** rather than everything, because a sidecar exists to be read
 * after a child misbehaved and the last thing it said is the useful part —
 * the same policy `CronLogStore.rotate` applies to a file Bernard does own.
 * The kept block starts at the first line break inside it so a reader does not
 * open on half a stack frame, and the dropped bytes are named at the head:
 * a bounded thing says so.
 *
 * **Two race windows, both real, neither closable in place.** The descriptor is
 * SHARED: `mcpStderrTarget` hands the same fd to every stdio MCP server, so
 * several children append here concurrently and both windows are likelier than
 * one server makes them look.
 *
 * A write landing between the read and the truncate is lost — and is also
 * missing from the dropped-bytes count, which is computed from the pre-truncate
 * `fstat`. Re-`fstat`ing just before the truncate would narrow that count's
 * window without closing it, which is more syscalls for a precision the number
 * still would not have.
 *
 * A write landing between the truncate and the restore survives, but lands
 * BEFORE the restored block. That is why the restore is **one** `writeSync` of
 * header+tail rather than two: with two, such a write landed between them —
 * newest line at the top of the file with half a megabyte of older output after
 * it, which is precisely the inversion the tail-keeping policy exists to
 * prevent. One write narrows the stranding to the header's own length. It does
 * **not** close it, because truncate-then-restore cannot be made atomic on a
 * descriptor somebody else is appending to.
 *
 * Both are accepted rather than solved: each is bounded by a syscall or two, on
 * debug output from which we have just deliberately discarded seven eighths, and
 * refusing to bound the file to protect those windows would be the worse trade.
 * `O_APPEND` keeps each individual write atomic at the offset, so nothing
 * interleaves mid-line either way.
 */
function boundSidecar(fd: number): void {
  try {
    const { size } = fs.fstatSync(fd);
    if (size <= SIDECAR_MAX_BYTES) return;

    const tail = Buffer.alloc(SIDECAR_KEEP_BYTES);
    const read = fs.readSync(fd, tail, 0, SIDECAR_KEEP_BYTES, size - SIDECAR_KEEP_BYTES);
    // Start on a line boundary when there is one; a buffer with no break at
    // all is one enormous line, and dropping it whole to tidy the head would
    // throw away everything we came to keep.
    const nl = tail.indexOf(0x0a);
    const from = nl >= 0 && nl + 1 < read ? nl + 1 : 0;

    const head = Buffer.from(
      `--- bernard: dropped ${size - (read - from)} earlier bytes to keep this sidecar under ${SIDECAR_MAX_BYTES} ---\n`,
    );
    fs.ftruncateSync(fd, 0);
    // ONE write, not two — see the race note above. The concat copies the kept
    // block, on the branch that already decided to discard seven eighths of it.
    fs.writeSync(fd, Buffer.concat([head, tail.subarray(from, read)]));
  } catch {
    // Same contract as everything else here: never let housekeeping on a debug
    // file break, or even be noticed by, the caller's real work.
  }
}
