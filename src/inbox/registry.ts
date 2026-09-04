import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../fs-utils.js';
import { SESSIONS_DIR, sessionInboxDir, sessionRecordPath } from '../paths.js';
import { isSessionRecord, type InboxKind, type SessionRecord } from './types.js';
import { isPidAlive } from '../pid.js';

/**
 * Which REPLs are running, so a message can be addressed to one (#462).
 *
 * Nothing recorded this before. `getSessionId()` names log files and is gated
 * on `BERNARD_DEBUG`, so it was never an index — a sender had no way to
 * discover a session at all.
 *
 * ## Liveness is a PID check, and that is acceptable here
 *
 * `src/host/client.ts` argues, correctly, that `kill(pid, 0)` cannot tell
 * Bernard from a process that recycled the PID, and that a health probe is
 * strictly better. It is — for a server. What that weakness costs *here* is
 * the question, and the answer is: nothing dangerous. A recycled PID makes a
 * dead session look alive, so a message is written into an inbox nobody
 * drains; the sender waits, sees the file is still there, and reports that it
 * was not picked up. **A stale port entry can hand your payload to a stranger;
 * a stale PID entry can only fail to deliver.** That asymmetry is why a file
 * transport is safe with a weaker liveness check than a socket would need.
 */

/** Registers this process as a live session and prepares its inbox. */
export function registerSession(opts: {
  sessionId: string;
  capabilities?: readonly InboxKind[];
}): SessionRecord {
  const inboxDir = sessionInboxDir(opts.sessionId);
  // 0700 on the inbox is the credential: a message transport with no token
  // works because the kernel refuses another user's write. `recursive: true`
  // does not chmod an existing parent, which is fine — creating a file in
  // `inbox/<id>/` needs write+execute on THAT directory, so a 0755 grandparent
  // grants nothing.
  fs.mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });

  const record: SessionRecord = {
    schemaVersion: 1,
    sessionId: opts.sessionId,
    pid: process.pid,
    startedAt: Date.now(),
    cwd: process.cwd(),
    inboxDir,
    capabilities: opts.capabilities ?? ['notice'],
  };
  atomicWriteFileSync(sessionRecordPath(opts.sessionId), JSON.stringify(record, null, 2), {
    mode: 0o600,
  });
  return record;
}

/**
 * Removes this session and anything still addressed to it.
 *
 * Undelivered messages for a session that has exited are garbage — nobody will
 * ever render them, and leaving them would make a re-used session id inherit
 * a stranger's backlog.
 */
export function unregisterSession(sessionId: string): void {
  try {
    fs.rmSync(sessionRecordPath(sessionId), { force: true });
    fs.rmSync(sessionInboxDir(sessionId), { recursive: true, force: true });
  } catch {
    // Teardown must never throw: this runs from an unmount effect, and the
    // process is on its way out either way.
  }
}

/** Every session that still has a live process, most recently started last. */
export function listLiveSessions(): SessionRecord[] {
  return scanSessions(false);
}

/**
 * The live sessions, sweeping the dead ones in the same pass.
 *
 * One `readdir` and one parse per record, where reaping and then listing was
 * two of each — and `bernard say` did it three times over, since the CLI
 * reaped, `sendToSessions` reaped again, and `resolveTargets` then listed. The
 * scans answer the same question from the same files with nothing mutating
 * between them, so doing it once is not an optimisation so much as removing a
 * repeat.
 */
export function reapAndListLiveSessions(): SessionRecord[] {
  return scanSessions(true);
}

function scanSessions(reap: boolean): SessionRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  const live: SessionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(SESSIONS_DIR, name);
    const record = readRecord(file);
    if (record && isPidAlive(record.pid)) {
      live.push(record);
      continue;
    }
    // An unreadable or unknown-version record is swept too: it addresses
    // nothing this binary can deliver to, and leaving it makes every listing
    // noisier forever.
    if (!reap) continue;
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(record ? record.inboxDir : sessionInboxDir(name.replace(/\.json$/, '')), {
        recursive: true,
        force: true,
      });
    } catch {
      // Another process may have swept it first.
    }
  }
  return live.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Drops records whose process is gone. Best-effort and never throws — it runs
 * at REPL start, where a stale file must not stop the session.
 */
export function reapDeadSessions(): void {
  reapAndListLiveSessions();
}

/**
 * Finds the session a user named, git-style.
 *
 * Returns `'ambiguous'` rather than guessing: the whole point of naming one is
 * that the caller knows which they mean, and picking the "closest" match would
 * deliver to the wrong terminal in exactly the case the flag exists for.
 */
export function resolveSession(
  prefix: string,
  live: SessionRecord[] = listLiveSessions(),
): SessionRecord | 'ambiguous' | null {
  const matches = live.filter((s) => s.sessionId.startsWith(prefix));
  if (matches.length === 0) return null;
  if (matches.length > 1) return 'ambiguous';
  return matches[0];
}

function readRecord(file: string): SessionRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return isSessionRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
