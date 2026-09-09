/**
 * @module jsonl
 *
 * Shared, fail-open JSONL file primitives. Bernard keeps several append-only
 * JSONL logs (tool-wrapper reasoning, session telemetry, per-session debug logs)
 * that each independently re-implemented the same append / tail-read / count-
 * rotate / list-by-mtime dance. This is the single home for that behavior so the
 * malformed-line, rotation, and race-tolerant-listing semantics can't drift.
 *
 * Every function is **fail-open**: logging/telemetry must never break the caller,
 * so I/O errors are swallowed (reads return `[]`, writes no-op). Callers with
 * different semantics use `fs` directly instead — e.g. cron's log store, which
 * reads newest-first with pagination and rotates by *size* (so it must always
 * truncate, unlike the count-threshold `rotateJsonlByCount`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from './fs-utils.js';

/** Dirs already `mkdir`'d this process — avoids a syscall on every append. */
const readyDirs = new Set<string>();

/**
 * Append one object as a JSONL line, lazily creating the file's parent dir
 * (once per dir per process). Never throws.
 */
export function appendJsonl(filePath: string, entry: unknown): void {
  try {
    const dir = path.dirname(filePath);
    if (!readyDirs.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      readyDirs.add(dir);
    }
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // best-effort; a logging failure must not propagate into the hot path
  }
}

/**
 * Parse a JSONL file's most-recent `limit` records (all when omitted), skipping
 * blank and malformed lines. Never throws — returns `[]` on any error / missing
 * file. Callers supply the record type via `T`.
 */
export function readJsonlTail<T = unknown>(filePath: string, limit?: number): T[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const tail = limit != null ? lines.slice(-limit) : lines;
    const out: T[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Every record NEWER than a cursor, oldest-first, reading backwards from EOF.
 *
 * The difference from {@link readJsonlTail} is not performance, it is
 * correctness. That one takes a fixed `limit`, and its limit bounds only the
 * PARSE — it `readFileSync`s the whole file and then slices — so a consumer
 * using it as a queue silently drops everything between its cursor and the
 * start of the window. `runSpecialistRecall` was doing exactly that: scanning a
 * fixed 500 entries against a timestamp marker, and reporting the loss it could
 * detect without being able to recover it.
 *
 * Reading backwards makes the window the cursor. Everything since the marker is
 * returned however many entries precede it, and nothing before it is parsed —
 * so this is also strictly less I/O than a tail read on the file that motivated
 * it (measured 6.7 MB / 2,354 entries on a real install).
 *
 * `isOlderThanCursor` decides where to stop; a predicate rather than a
 * timestamp, so the caller keeps its own notion of order — the reasoning log's
 * `ts` is an ISO string, and a future caller may key on something else. A record
 * the predicate cannot judge is KEPT: on an append-only log the only thing worse
 * than re-reading a record is not reading it.
 *
 * Fail-open like its neighbours: `[]` on any I/O error or missing file.
 *
 * @param maxRecords A ceiling on one pass, so a consumer that has not run in a
 *   very long time cannot pull an unbounded number of records into memory.
 *   Reached without meeting the cursor, the result is truncated at the OLDEST
 *   end — the newest records are the ones a caller cannot afford to lose.
 */
export function readJsonlSince<T = unknown>(
  filePath: string,
  isOlderThanCursor: (entry: T) => boolean,
  maxRecords = 5000,
): T[] {
  let fd: number | undefined;
  try {
    if (!fs.existsSync(filePath)) return [];
    fd = fs.openSync(filePath, 'r');
    let pos = fs.fstatSync(fd).size;
    // The partial first line of the chunk just read; the chunk BEFORE it
    // completes it.
    let carry = '';
    const out: T[] = [];
    while (pos > 0 && out.length < maxRecords) {
      const size = Math.min(BACKWARD_CHUNK_BYTES, pos);
      pos -= size;
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, pos);
      const lines = (buf.toString('utf-8') + carry).split('\n');
      // Unless we reached the file's start, the first element continues into
      // the chunk that precedes this one.
      carry = pos > 0 ? (lines.shift() ?? '') : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let parsed: T;
        try {
          parsed = JSON.parse(line) as T;
        } catch {
          continue; // malformed line, as everywhere else in this module
        }
        if (isOlderThanCursor(parsed)) return out.reverse();
        out.push(parsed);
        if (out.length >= maxRecords) break;
      }
    }
    return out.reverse();
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}

/** How much of a JSONL file {@link readJsonlSince} pulls in at a time. */
const BACKWARD_CHUNK_BYTES = 64 * 1024;

/**
 * Trim a JSONL file to its last `keep` lines via an atomic tmp+rename write.
 * No-ops when the file is absent or already within budget. Never throws.
 */
export function rotateJsonlByCount(filePath: string, keep: number): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const lines = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    if (lines.length <= keep) return;
    atomicWriteFileSync(filePath, lines.slice(-keep).join('\n') + '\n');
  } catch {
    // best-effort
  }
}

export interface FileByMtime {
  /** Base name including extension. */
  name: string;
  /** Absolute path. */
  path: string;
  mtimeMs: number;
}

/**
 * List the files in `dir` (optionally filtered by extension, e.g. `.jsonl`),
 * newest-first by mtime. Race-tolerant — a file that vanishes between `readdir`
 * and `stat` sorts as oldest rather than throwing. Never throws — returns `[]`
 * when the directory is missing/unreadable.
 */
export function listFilesByMtime(dir: string, ext?: string): FileByMtime[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && (!ext || e.name.endsWith(ext)))
    .map((e) => {
      const full = path.join(dir, e.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        // vanished between readdir and stat — treat as oldest
      }
      return { name: e.name, path: full, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Delete all but the `keep` most-recent files (by mtime) in `dir`, optionally
 * filtered by `ext`. Best-effort — a file that vanishes is ignored, and the
 * whole pass never throws. The shared retention primitive behind both the debug
 * session-log and per-session telemetry rotation.
 */
export function pruneFilesByMtime(dir: string, keep: number, ext?: string): void {
  for (const f of listFilesByMtime(dir, ext).slice(keep)) {
    try {
      fs.unlinkSync(f.path);
    } catch {
      // already gone or unreadable — ignore
    }
  }
}

/**
 * Delete all but the `keep` most-recent file *groups* in `dir`, where `groupOf`
 * maps a filename to the key its files share (returning `null` to exclude a
 * file from retention entirely). A group ranks by its newest member, and is
 * deleted whole.
 *
 * The sibling of {@link pruneFilesByMtime}, for a directory where one logical
 * unit spans several files — a debug session that writes `<id>.jsonl` plus a
 * sidecar per spawned subsystem. Ranking those files individually is wrong in
 * three ways that all read as correct locally: a per-extension pass has to be
 * hand-extended for every new sidecar (one that is forgotten is simply never
 * pruned, silently), the passes rank independently so the Nth-newest `.jsonl`
 * and the Nth-newest sidecar belong to different sessions and each retains
 * orphans of the other, and `keep` silently means "keep × extensions" rather
 * than the session count it is written as. Grouping makes the retention unit
 * the thing the budget is actually about.
 */
export function pruneFileGroupsByMtime(
  dir: string,
  keep: number,
  groupOf: (name: string) => string | null,
): void {
  // Newest-first input, so the first sighting of a key is that group's newest
  // member and insertion order is already the group ranking.
  const groups = new Map<string, string[]>();
  for (const f of listFilesByMtime(dir)) {
    const key = groupOf(f.name);
    if (key === null) continue;
    const existing = groups.get(key);
    if (existing) existing.push(f.path);
    else groups.set(key, [f.path]);
  }
  for (const paths of [...groups.values()].slice(keep)) {
    for (const p of paths) {
      try {
        fs.unlinkSync(p);
      } catch {
        // already gone or unreadable — ignore
      }
    }
  }
}
