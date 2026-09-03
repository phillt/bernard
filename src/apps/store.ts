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
    // One statement rather than four assembled ones: both predicates have a
    // neutral value — `substr(key, 1, 0) = ''` is true for every row, and
    // `key > ''` is too, since `set` rejects an empty key — so the unfiltered
    // case needs no separate SQL.
    //
    // `substr`, never `LIKE`, whose `%` and `_` are wildcards: that would make
    // the caller's prefix a pattern rather than the literal text it is.
    //
    // `after` is exclusive because it is a cursor — the caller passes back the
    // last key it saw — which is why it is a separate parameter from the
    // prefix rather than one value carrying two boundary rules.
    const prefix = opts.prefix ?? '';
    const rows = this.db
      .prepare(
        'SELECT key, value, updated_at FROM kv ' +
          'WHERE substr(key, 1, ?) = ? AND key > ? ORDER BY key LIMIT ?',
      )
      .all(prefix.length, prefix, opts.after ?? '', limit) as {
      key: string;
      value: string;
      updated_at: string;
    }[];
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

/**
 * The store's whole request vocabulary, as data.
 *
 * Both doors — the HTTP route and the `applet_store` tool — dispatch through
 * {@link applyStoreOp} rather than each switching on an op string. They had
 * already diverged when written twice: one clamped `limit` and the other did
 * not. What legitimately differs is only the ENCODING each door receives
 * (`value` arrives as JSON text through the tool's string parameter and as a
 * JSON value through the route), so that stays at each door and nothing else
 * does.
 */
export type StoreOp =
  | { op: 'get'; key: string }
  | { op: 'set'; key: string; value: unknown }
  | { op: 'delete'; key: string }
  | { op: 'list'; prefix?: string; limit?: number; after?: string };

export type StoreOpResult =
  | { kind: 'entry'; entry: StoreEntry | null }
  | { kind: 'written'; entry: StoreEntry }
  | { kind: 'deleted'; deleted: boolean }
  | { kind: 'entries'; entries: StoreEntry[] };

export function applyStoreOp(store: AppletStore, op: StoreOp): StoreOpResult {
  switch (op.op) {
    case 'get':
      return { kind: 'entry', entry: store.get(op.key) };
    case 'set':
      return { kind: 'written', entry: store.set(op.key, op.value) };
    case 'delete':
      return { kind: 'deleted', deleted: store.delete(op.key) };
    case 'list':
      return { kind: 'entries', entries: store.list(op) };
  }
}

/**
 * One connection per applet, for the life of the process.
 *
 * Shared by **both** doors — the HTTP route and the `applet_store` tool — and
 * that sharing is the point, not a convenience. The applet host is long-lived
 * and runs both: a connection opened per dispatch and never closed leaks a
 * descriptor and a WAL mapping per invocation, and puts a second writer on a
 * file the route already holds open, manufacturing exactly the contention the
 * busy timeout exists to absorb.
 *
 * Bounded by the number of installed applets, so it does not grow with traffic.
 */
const connections = new Map<string, AppletStore>();

export function appletStoreFor(appId: string): AppletStore {
  let store = connections.get(appId);
  if (!store) {
    store = new AppletStore(appId);
    connections.set(appId, store);
  }
  return store;
}

/** Drops one app's connection — the host calls this when it stops serving it. */
export function closeAppletStore(appId: string): void {
  const store = connections.get(appId);
  if (!store) return;
  connections.delete(appId);
  try {
    store.close();
  } catch {
    // Already closed, or the file went away. Nothing left to do.
  }
}

/**
 * Closes every cached connection.
 *
 * Called on host shutdown so WAL checkpoints rather than being left to
 * `process.exit`, and so an in-process embedder (the tests) does not leak a
 * handle per app per run.
 */
export function closeAllAppletStores(): void {
  for (const appId of [...connections.keys()]) closeAppletStore(appId);
}
