import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appletDataDir } from '../paths.js';
import { APP_ID_RE } from './manifest.js';

/**
 * An applet's persistent key-value store (#422).
 *
 * **A key-value store, not declared tables and certainly not raw SQL.** The
 * caller on one side is a browser page whose input reaches here through a
 * capability endpoint; handing that caller an interpretable string is the
 * whole class of mistake the action-selector design exists to close. A key and
 * a JSON value admit no query language, so there is nothing to inject into.
 * Being schema-free also means there is no migration story to get wrong yet.
 *
 * Two processes touch one file — the applet host serving the page, and an
 * agent dispatch running an action — which is why WAL and a real busy timeout
 * are not optional. `node:sqlite`'s busy timeout **defaults to 0**, i.e. fail
 * immediately with `SQLITE_BUSY`, and leaving it unset is the most likely
 * cause of a spurious "database is locked".
 *
 * `node:sqlite` is still experimental in Node 22 and prints a one-per-process
 * warning to **stderr**. That is safe for both machine-readable callers: the
 * host daemon is spawned `stdio: 'ignore'`, and `bernard script` writes its
 * JSON to stdout with diagnostics on stderr. The warning is not suppressed —
 * this repo has no suppression convention, and introducing the first one to
 * hide a true statement about an API's stability is the wrong trade.
 */

/**
 * `node:sqlite` is loaded through `createRequire`, not a static import.
 *
 * Node excludes experimental modules from `module.builtinModules`, so bundlers
 * do not recognise the specifier as a builtin: Vite strips the `node:` prefix
 * and tries to resolve `sqlite` from disk, which is a hard load error at
 * import time rather than a missing export — a test that merely imports this
 * module could not be collected. The type import above is erased, so the types
 * are still real.
 *
 * The same idiom `src/permissions/shell-ast.ts` uses, for the same reason.
 */
const { DatabaseSync: SQLiteDatabase } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

/** Values are stored as JSON text, so anything structured-cloneable round-trips. */
export interface StoreEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

/** Keys are opaque to Bernard but bounded, so one applet cannot fill the disk with one row. */
export const MAX_KEY_LENGTH = 512;
/** ~1 MB of JSON per value. Generous for a page's state, small enough to bound. */
export const MAX_VALUE_BYTES = 1_000_000;
/** A single `list` page. */
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 1000;

export class AppletStore {
  private readonly db: DatabaseSync;

  constructor(appId: string) {
    if (!APP_ID_RE.test(appId)) {
      // The id becomes a directory name. Rejected rather than sanitised: a
      // repaired id addresses a different store than the caller named.
      throw new Error(`Not a valid app id: ${appId}`);
    }
    const dir = appletDataDir(appId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'data.db');

    // `atomicWriteFileSync`'s temp-and-rename cannot apply to a file SQLite
    // holds open, so the 0600 story here is a `chmod` after create — which
    // does leave the window `src/host/registry.ts` argues against. Named
    // rather than glossed: the containing directory is created 0700 first, so
    // the window is inside a directory nothing else can traverse.
    const existed = fs.existsSync(file);
    this.db = new SQLiteDatabase(file, { timeout: 5_000 });
    if (!existed) {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // A filesystem without POSIX modes. The 0700 directory still holds.
      }
    }

    // WAL lets a reader and a writer proceed at once, which is the two-process
    // shape this store lives in. NORMAL trades an fsync per commit for the
    // possibility of losing the last transaction on power loss — the right
    // trade for a page's UI state.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS kv (' +
        'key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)',
    );
  }

  get(key: string): StoreEntry | null {
    const row = this.db.prepare('SELECT key, value, updated_at FROM kv WHERE key = ?').get(key) as
      | { key: string; value: string; updated_at: string }
      | undefined;
    return row ? toEntry(row) : null;
  }

  set(key: string, value: unknown): StoreEntry {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      throw new Error(`Key must be 1-${MAX_KEY_LENGTH} characters.`);
    }
    let json: string;
    try {
      json = JSON.stringify(value ?? null);
    } catch {
      throw new Error('Value is not JSON-serialisable.');
    }
    // Measured in BYTES, not characters: the cap is about disk, and a string
    // of astral-plane characters is four times its length.
    if (Buffer.byteLength(json, 'utf-8') > MAX_VALUE_BYTES) {
      throw new Error(`Value exceeds ${MAX_VALUE_BYTES} bytes.`);
    }
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, json, updatedAt);
    return { key, value, updatedAt };
  }

  delete(key: string): boolean {
    const info = this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
    return Number(info.changes) > 0;
  }

  /**
   * A page of entries, key-ordered, optionally under a prefix.
   *
   * Ordered and paged rather than "everything": an applet's store has no upper
   * bound the caller controls, and a `list` that returns all of it is the
   * unbounded-result problem `mcp-result-shaper.ts` exists to solve, one layer
   * further out.
   */
  list(opts: { prefix?: string; limit?: number; after?: string } = {}): StoreEntry[] {
    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
    const prefix = opts.prefix ?? '';
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (prefix !== '') {
      // A `LIKE` pattern would make the caller's prefix interpretable (`%`,
      // `_` are wildcards). `substr` compares it as the literal text it is,
      // and still uses the primary-key index for the range below.
      where.push('substr(key, 1, ?) = ?');
      params.push(prefix.length, prefix);
    }
    // Exclusive, because it is a cursor: the caller passes back the last key it
    // saw. Separate from the prefix so one parameter does not carry two
    // meanings with two different boundary rules.
    if (opts.after !== undefined) {
      where.push('key > ?');
      params.push(opts.after);
    }
    params.push(limit);

    const rows = this.db
      .prepare(
        'SELECT key, value, updated_at FROM kv' +
          (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
          ' ORDER BY key LIMIT ?',
      )
      .all(...params) as { key: string; value: string; updated_at: string }[];
    return rows.map(toEntry);
  }

  close(): void {
    this.db.close();
  }
}

function toEntry(row: { key: string; value: string; updated_at: string }): StoreEntry {
  let value: unknown = null;
  try {
    value = JSON.parse(row.value);
  } catch {
    // A hand-edited database. The key still exists, so report it with a null
    // value rather than making the whole listing fail.
  }
  return { key: row.key, value, updatedAt: row.updated_at };
}
