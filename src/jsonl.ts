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
 * so I/O errors are swallowed (reads return `[]`, writes no-op). Callers that
 * need throwing semantics (e.g. cron's size-based rotation) use `fs` directly.
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
