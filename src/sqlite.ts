import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Opening a `node:sqlite` database the way this repo has twice decided it
 * should be opened.
 *
 * Extracted after the second store (#516) copied the first (`apps/store.ts`,
 * #422) line for line: the lazy loader, the mkdir-then-open-then-chmod
 * sequence, the pragmas and the connection cache were four separate
 * duplications, and the loader's own comment already named a THIRD copy of the
 * `createRequire`-for-a-builtin idiom in `permissions/shell-ast.ts`. Everything
 * here is quirk-handling for an experimental module and a filesystem race;
 * maintaining it in two places means fixing one and leaving the other.
 *
 * What deliberately does NOT live here is schema, migration or any opinion
 * about what a row is. Each store owns those.
 */

/**
 * `node:sqlite`, resolved through `createRequire` on FIRST USE.
 *
 * Both halves matter and both were learned the hard way. Node excludes
 * experimental modules from `module.builtinModules`, so a static import is not
 * recognised as a builtin: Vite strips the `node:` prefix, fails to resolve
 * `sqlite` from disk, and a test that merely imports the module cannot be
 * collected. And requiring it at module load rather than first use prints
 * Node's one-per-process `ExperimentalWarning` on every command that imports
 * anything downstream — `bernard app list` and `--help` included, neither of
 * which opens a database.
 *
 * The warning is not suppressed. It is true whenever SQLite is actually used,
 * and this repo has no suppression convention worth starting to hide a correct
 * statement about an API's stability.
 */
let sqlite: typeof import('node:sqlite') | undefined;
export function sqliteModule(): typeof import('node:sqlite') {
  return (sqlite ??= createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'));
}

export interface OpenSqliteOptions {
  /** Milliseconds to wait on a locked database. Never leave this unset — see below. */
  timeoutMs?: number;
  /** `NORMAL` (default) trades an fsync per commit for the last transaction on power loss. */
  synchronous?: 'NORMAL' | 'FULL';
}

/**
 * Open (creating if needed) a private SQLite file at `dir/filename`.
 *
 * - The directory is created `0700` FIRST, so the window before the file's
 *   `chmod` lands is inside a directory nothing else can traverse. That window
 *   is unavoidable: `atomicWriteFileSync`'s temp-and-rename cannot apply to a
 *   file SQLite holds open.
 * - **WAL** lets a reader and a writer proceed at once, which is the shape both
 *   callers live in — a daemon serving while a dispatch writes, or an ingest in
 *   one terminal while a REPL searches in another.
 * - **The busy timeout is not optional.** `node:sqlite` defaults it to 0, i.e.
 *   fail immediately with `SQLITE_BUSY`, and leaving it unset is the likeliest
 *   cause of a spurious "database is locked".
 */
export function openSqliteFile(
  dir: string,
  filename: string,
  opts: OpenSqliteOptions = {},
): { db: DatabaseSync; file: string } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, filename);
  const existed = fs.existsSync(file);
  const db = new (sqliteModule().DatabaseSync)(file, { timeout: opts.timeoutMs ?? 5_000 });
  if (!existed) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // A filesystem without POSIX modes. The 0700 directory still holds.
    }
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`PRAGMA synchronous = ${opts.synchronous ?? 'NORMAL'}`);
  return { db, file };
}

/**
 * One open store per owner id per process.
 *
 * A connection opened per call and never closed leaks a descriptor and a WAL
 * mapping per invocation inside a long-lived process, and puts a second writer
 * on a file this process already holds open — manufacturing the contention the
 * busy timeout exists to absorb.
 *
 * A class rather than a bare `Map` plus three functions, because the three
 * functions are the same three every time and the second store wrote them out
 * again with the identifiers renamed.
 */
export class SqliteConnectionCache<T extends { close(): void }> {
  private readonly open = new Map<string, T>();

  constructor(private readonly make: (id: string) => T) {}

  get(id: string): T {
    const existing = this.open.get(id);
    if (existing) return existing;
    const created = this.make(id);
    this.open.set(id, created);
    return created;
  }

  close(id: string): void {
    const store = this.open.get(id);
    if (!store) return;
    // Deleted BEFORE closing, so a throw from `close` cannot leave a dead
    // handle in the map for the next caller to be handed.
    this.open.delete(id);
    try {
      store.close();
    } catch {
      // Already closed, or the file went away underneath us.
    }
  }

  /** Closes every open store so WAL checkpoints rather than being left to exit. */
  closeAll(): void {
    for (const id of [...this.open.keys()]) this.close(id);
  }
}
