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
import { atomicWriteFileSyncUnique } from './fs-utils.js';

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
 * **`reachedCursor` is the half a caller using this as a queue needs**, and is
 * why this returns an object rather than an array. Every entry returned is newer
 * than the cursor BY CONSTRUCTION, so a caller cannot tell "I saw everything"
 * from "I stopped early" by inspecting them — any test it writes against the
 * oldest one is a tautology. False means the scan ran out of file or out of
 * ceiling without ever meeting the cursor, i.e. records between the two are
 * gone: rotation evicted them, or there are more than one pass will carry.
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
): { entries: T[]; reachedCursor: boolean } {
  let fd: number | undefined;
  try {
    // An absent file has no records before the cursor either, so there is
    // nothing lost — `true` keeps a first run from reporting a gap.
    if (!fs.existsSync(filePath)) return { entries: [], reachedCursor: true };
    fd = fs.openSync(filePath, 'r');
    let pos = fs.fstatSync(fd).size;
    // One buffer for the whole scan rather than a fresh 64 KB per chunk; the
    // explicit `length` argument to `readSync` is what makes reuse safe on the
    // final short chunk.
    const buf = Buffer.allocUnsafe(BACKWARD_CHUNK_BYTES);
    // The partial first line of the chunk just read, as FRAGMENTS in
    // newest-to-oldest order; the chunk before it completes them. A string
    // concatenated per chunk is quadratic in how many chunks one line spans —
    // measured 974 ms for a single 16 MB row against 21 ms to read the file
    // whole — and `captureToolCalls` stores a tool's `args` verbatim, so a
    // `file_write` of an applet page is an ordinary megabyte-sized row. Joined
    // only when a newline is actually found, so a long line is copied once.
    let carry: string[] = [];
    const out: T[] = [];
    while (pos > 0 && out.length < maxRecords) {
      const size = Math.min(BACKWARD_CHUNK_BYTES, pos);
      pos -= size;
      fs.readSync(fd, buf, 0, size, pos);
      const text = buf.toString('utf-8', 0, size);
      // A chunk with no newline is entirely part of one record that continues
      // before it — accumulate it and concatenate nothing. This is the line that
      // makes the fragment list worth having: joining per chunk would copy every
      // byte of a long record once per chunk it spans.
      if (pos > 0 && !text.includes('\n')) {
        carry.unshift(text);
        continue;
      }
      const lines = (text + carry.join('')).split('\n');
      // Unless we reached the file's start, the first element continues into
      // the chunk that precedes this one.
      carry = pos > 0 ? [lines.shift() ?? ''] : [];
      for (let i = lines.length - 1; i >= 0 && out.length < maxRecords; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let parsed: T;
        try {
          parsed = JSON.parse(line) as T;
        } catch {
          continue; // malformed line, as everywhere else in this module
        }
        if (isOlderThanCursor(parsed)) return { entries: out.reverse(), reachedCursor: true };
        out.push(parsed);
      }
    }
    // Out of file or out of ceiling without meeting the cursor.
    return { entries: out.reverse(), reachedCursor: false };
  } catch {
    // A read that failed saw nothing, so it cannot claim to have seen
    // everything — the caller must be free to try again.
    return { entries: [], reachedCursor: false };
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
 * Rows appended per file since this process last trimmed it, so the trim can be
 * amortised. Per-process, like every other counter in this module's callers.
 */
const sinceRotate = new Map<string, number>();

/**
 * How far past `keep` a file is allowed to drift before a trim. One rewrite per
 * `keep * (SLACK - 1)` appends, so the file is bounded within 25% of what the
 * caller asked for and no append pays for the rewrite of the one before it.
 */
const ROTATE_SLACK = 1.25;

/**
 * Append one record and keep the file near `keep` rows, amortised.
 *
 * **The pairing three loggers had written by hand, and the reason it needed to
 * be one function.** `appendJsonl` + `rotateJsonlByCount` on every append reads,
 * splits and atomically rewrites the WHOLE file each time — and rotation pins
 * the file *at* `keep` rows, which is exactly the size that forces a rewrite on
 * the next append. Measured on the real 6.7 MB reasoning log at 2,000 rows:
 * **25.7 ms per append**, synchronously, on the return path of every dispatch,
 * against 0.012 ms for the append alone. Ink throttles rendering at 32 ms, so one
 * log write was eating most of a frame. The two pre-existing callers did not feel
 * it because their rows are ~250 bytes; the reasoning log's are ~2.8 KB, which is
 * why copying their shape transferred the code and not the cost.
 *
 * Amortising puts it at **0.035 ms** and one rewrite per `keep / 4` appends.
 * The counter is per-process and starts at zero, so a fresh process trims on its
 * first append — which is also what re-bounds a file some other process grew.
 *
 * Never throws: a logging failure must not propagate into the hot path.
 */
export function appendJsonlBounded(filePath: string, entry: unknown, keep: number): void {
  try {
    appendJsonl(filePath, entry);
    const n = (sinceRotate.get(filePath) ?? 0) + 1;
    if (n < Math.ceil(keep * (ROTATE_SLACK - 1))) {
      sinceRotate.set(filePath, n);
      return;
    }
    sinceRotate.set(filePath, 0);
    rotateJsonlByCount(filePath, keep);
  } catch {
    // best-effort, like every other write here
  }
}

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
    // UNIQUE temp name: `fs-utils.ts` says to use this variant wherever two
    // processes can write the same file, and the reasoning log has four writers
    // (the REPL, the cron daemon, the applet host and `bernard script`). A fixed
    // suffix leaves one orphan that the next write overwrites; the unique form
    // unlinks its own on failure.
    atomicWriteFileSyncUnique(filePath, lines.slice(-keep).join('\n') + '\n');
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
