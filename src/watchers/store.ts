/**
 * @module watchers/store
 *
 * Watcher records on disk. One file per watcher under {@link WATCHERS_DIR}.
 *
 * **One file each, not one array** — the single place this deliberately
 * diverges from `CronStore`. That store re-reads and rewrites the whole
 * `jobs.json` on every mutation with no locking, so two concurrent writers lose
 * one another's edits. For cron that is rare; here it is the normal case, since
 * several sessions can each hold watchers and each polls its own on its own
 * clock, writing `lastCheckedAt` every interval.
 *
 * Records **persist across restarts** even though polling is session-scoped, and
 * that is a deliberate middle ground rather than an unfinished version of the
 * deferred offline feature. A watcher set at 09:00 for a reply that lands at
 * 16:00 must survive the restart in between; losing it silently is the failure
 * mode the whole feature exists to remove. What is deferred is polling while no
 * session is running — not remembering that you asked.
 */
// Named imports for the reason `probe.ts` records: a `default` import of
// `node:fs` fails at module load against the partial mocks several suites use.
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { atomicWriteFileSync } from '../fs-utils.js';
import { stableStringify } from './extract.js';
import { WATCHERS_DIR } from '../paths.js';
import {
  isValidWatcherId,
  isWatcher,
  MAX_FIRES_CEILING,
  MAX_LIFETIME_MS,
  carriedState,
  MAX_WATCHERS,
  MIN_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  type WatchPredicate,
  type WatchStatus,
  type WatchTarget,
  type Watcher,
} from './types.js';

export interface CreateWatcherInput {
  name: string;
  target: WatchTarget;
  predicate: WatchPredicate;
  instructions: string;
  ownerSessionId: string;
  intervalMs?: number;
  ttlMs?: number;
  /** Stay armed and fire repeatedly — see {@link Watcher.repeating}. */
  repeating?: boolean;
  maxFires?: number;
  /** Baseline captured by the caller BEFORE creating. See `create`. */
  snapshot?: string;
  baselineIds?: string[];
  etag?: string;
  lastModified?: string;
}

export class WatcherStore {
  constructor() {
    mkdirSync(WATCHERS_DIR, { recursive: true, mode: 0o700 });
  }

  private file(id: string): string {
    // Refuse, do not repair — `AppletBriefStore`'s rule. A repaired id addresses
    // a different record than the caller named, and here that means cancelling
    // or firing somebody else's watcher.
    if (!isValidWatcherId(id)) throw new Error(`Invalid watcher id: ${JSON.stringify(id)}`);
    return path.join(WATCHERS_DIR, `${id}.json`);
  }

  /** Every valid record on disk, newest first. Unreadable files are skipped. */
  list(): Watcher[] {
    let names: string[];
    try {
      names = readdirSync(WATCHERS_DIR).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: Watcher[] = [];
    for (const name of names) {
      // `.tmp` files from an in-flight atomic write live in this directory too,
      // and the `.json` filter above is what keeps a half-written one from being
      // parsed — the same reason `isMessageFile` exists in the inbox.
      const w = this.read(name.slice(0, -'.json'.length));
      if (w) out.push(w);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** One record, or `null` when absent, unparseable or not a watcher. */
  read(id: string): Watcher | null {
    let file: string;
    try {
      file = this.file(id);
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
      // Validated on READ, not only on write: the file is the user's own and
      // hand-editable between runs, so a write-time check alone is a
      // time-of-check/time-of-use gap (#420 R6).
      return isWatcher(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * An active watcher already looking at the same thing, if there is one.
   *
   * Keyed on target + predicate — NOT the name, which is free text a model
   * invents fresh each time, and not `instructions`, which is the thing that
   * legitimately differs between two watchers on one chat.
   *
   * It matters more since watchers can repeat: a one-shot duplicate fires twice
   * and is done, while two repeating watchers on the same chat wake the session
   * twice for every message, indefinitely, and nothing in the transcript says
   * why. Six watchers were created on one chat in a single observed session.
   */
  findDuplicate(target: Watcher['target'], predicate: Watcher['predicate']): Watcher | null {
    const key = duplicateKey(target, predicate);
    if (key === null) return null;
    return (
      this.list().find(
        (w) => w.status === 'active' && duplicateKey(w.target, w.predicate) === key,
      ) ?? null
    );
  }

  /**
   * Creates a watcher.
   *
   * The caller passes the baseline it already probed — see `poller.ts`. Taking
   * it HERE would mean this store performing I/O against the network and the
   * MCP registry, and taking it on the first poll instead would make every
   * `changed` watcher fire immediately, since a real digest compares unequal to
   * an absent one.
   */
  create(input: CreateWatcherInput): Watcher {
    const active = this.list().filter((w) => w.status === 'active');
    if (active.length >= MAX_WATCHERS) {
      throw new Error(
        `Too many active watchers (${active.length}/${MAX_WATCHERS}). Cancel one first.`,
      );
    }
    const now = Date.now();
    const ttl = Math.min(input.ttlMs ?? MAX_LIFETIME_MS, MAX_LIFETIME_MS);
    const watcher: Watcher = {
      schemaVersion: 1,
      id: randomUUID(),
      name: input.name.slice(0, 80),
      createdAt: new Date(now).toISOString(),
      ownerSessionId: input.ownerSessionId,
      ownerPid: process.pid,
      status: 'active',
      target: input.target,
      predicate: input.predicate,
      instructions: input.instructions,
      intervalMs: Math.max(input.intervalMs ?? DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS),
      failureCount: 0,
      expiresAt: new Date(now + ttl).toISOString(),
      ...(input.repeating ? { repeating: true, fireCount: 0 } : {}),
      // Clamped like `intervalMs` and `ttlMs` above, and for the same reason:
      // every one of the three comes from a model that has no idea what a
      // reasonable value is.
      ...(input.maxFires === undefined
        ? {}
        : { maxFires: Math.max(1, Math.min(Math.floor(input.maxFires), MAX_FIRES_CEILING)) }),
      ...carriedState(input),
    };
    this.write(watcher);
    return watcher;
  }

  /**
   * Merges `patch` into the record on disk.
   *
   * Read-modify-write, and NOT safe against a concurrent writer. The claim that
   * "each record has exactly one owning session" was wrong on this module's own
   * terms: `sweep()` and `adoptOrphans()` both write records owned by other
   * sessions, so cross-session writes are routine rather than hypothetical.
   *
   * `known` makes it sharper, not safer: a whole-record overwrite from a
   * possibly-stale read can silently revert another writer's fields. The
   * concrete race is session A mid-`pollOne(w)` holding `w`, session B adopting
   * it, then A finishing and writing its stale `ownerSessionId` back. The window
   * is one poll and the consequence is a re-adoption on B's next tick, so it is
   * bounded rather than eliminated — stated here rather than discovered later.
   */
  update(
    id: string,
    patch: Partial<Omit<Watcher, 'id' | 'schemaVersion'>>,
    /**
     * The record the caller already holds, so the common path skips a re-read.
     *
     * `tick` parses every watcher through `ownedBy()` and then, milliseconds
     * later, `update` re-read and re-parsed the same file — pure duplication on
     * a loop that runs for the life of the session. Optional rather than
     * required: `sweep` and the `/watchers` menu genuinely do not have one.
     */
    known?: Watcher,
  ): Watcher | null {
    const current = known?.id === id ? known : this.read(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.write(next);
    return next;
  }

  /**
   * Writes `w` back verbatim, replacing whatever is on disk.
   *
   * The counterpart to `update`, for the one caller that holds the exact record
   * it wants restored rather than a description of what to change. A merge
   * cannot express it: `{...current, ...patch}` can only add or overwrite keys,
   * so a field the newer state ADDED — `firedAt` — survives a patch built by
   * spreading the older record. Passing the held record as `known` masks that,
   * since the merge base is then the old record too — which makes the rewind's
   * correctness depend on an optional performance argument being present.
   *
   * Same last-writer-wins caveat as `update`, and more bluntly: this does not
   * consult disk at all.
   */
  replace(w: Watcher): Watcher {
    this.write(w);
    return w;
  }

  /** Marks a terminal state. Returns the record, or `null` if it is gone. */
  finish(
    id: string,
    status: WatchStatus,
    extra: Partial<Watcher> = {},
    known?: Watcher,
  ): Watcher | null {
    return this.update(id, { status, ...extra }, known);
  }

  /** Removes a record entirely. Used by `/watchers` and by the sweep. */
  remove(id: string): void {
    try {
      unlinkSync(this.file(id));
    } catch {
      /* already gone, or a bad id — either way there is nothing to remove */
    }
  }

  /**
   * Drops records that are finished or past their deadline.
   *
   * Retention exists because nothing else would ever remove these: a watcher
   * that fired is terminal, and without a sweep the directory grows for the life
   * of the install — the unbounded-store shape `work-queue.ts` records having
   * had to fix in four candidate stores.
   */
  sweep(now = Date.now(), keepFinishedMs = 24 * 60 * 60 * 1000): number {
    let removed = 0;
    for (const w of this.list()) {
      if (w.status === 'active') {
        if (Date.parse(w.expiresAt) <= now) this.finish(w.id, 'expired', {}, w);
        continue;
      }
      // Age a terminal record from `finishedAt`, and `finishedAt` from the
      // CHECK time when there is no fire — only `finish(…, 'fired')` sets
      // `firedAt`, so `cancelled` / `expired` / `failed` all had `null` and were
      // deleted at the very next `start()` sweep regardless of the retention
      // window. `failed` is the one that cost: `lastError` is the only
      // diagnostic that path writes, and it was gone before anyone could read it.
      const finishedAt = Date.parse(w.firedAt ?? w.lastCheckedAt ?? w.createdAt);
      if (Number.isFinite(finishedAt) && now - finishedAt <= keepFinishedMs) continue;
      this.remove(w.id);
      removed += 1;
    }
    return removed;
  }

  private write(w: Watcher): void {
    atomicWriteFileSync(this.file(w.id), JSON.stringify(w, null, 2), { mode: 0o600 });
  }
}

/**
 * The identity of "watching the same thing", or `null` when the kind has no
 * such identity.
 *
 * Stable rather than clever: the fields are enumerated per target kind so a
 * field added later does not silently widen or narrow the key. `JSON.stringify`
 * over the whole target would be shorter and would also make key ORDER part of
 * the identity, which is a property of how the object was built rather than of
 * what it watches — which is why `stableStringify` does the sorting for `args`.
 *
 * **`time` returns `null`, and that is the point of the nullable return.** Two
 * `time` watchers for the same instant are not duplicates — "remind me at 3pm to
 * do X" and "…to do Y" are both wanted, and the instruction is exactly what the
 * key deliberately excludes. This previously spelled that as a `Math.random()`
 * term, which reads as a key and is not one: it makes an equality function
 * non-deterministic, so the same record compared against itself is unequal. A
 * caller that ever holds two keys and compares them — the obvious next use — is
 * silently wrong, and nothing about the expression says so.
 */
function duplicateKey(target: Watcher['target'], predicate: Watcher['predicate']): string | null {
  if (target.kind === 'time') return null;
  const t =
    target.kind === 'mcp'
      ? `mcp:${target.tool}:${stableStringify(target.args)}:${target.extract ?? ''}`
      : target.kind === 'http'
        ? `http:${target.url}`
        : `file:${target.path}`;
  const p =
    predicate.kind === 'appeared'
      ? `appeared:${predicate.idPath}:${predicate.where?.path ?? ''}=${String(predicate.where?.equals ?? '')}`
      : predicate.kind === 'matches'
        ? `matches:${predicate.pattern}`
        : 'changed';
  return `${t}|${p}`;
}
