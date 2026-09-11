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
import { isPidAlive } from '../pid.js';
import { WATCHERS_DIR } from '../paths.js';
import {
  isValidWatcherId,
  isWatcher,
  MAX_LIFETIME_MS,
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

  /** Watchers this session owns and should be polling. */
  ownedBy(sessionId: string): Watcher[] {
    return this.list().filter((w) => w.ownerSessionId === sessionId);
  }

  /**
   * Active watchers whose owning session is gone, so this one may adopt them.
   *
   * `kill(pid, 0)` liveness, the idiom `inbox/registry.ts` already uses and for
   * the reason it records: a stale PID can only fail to match, where a stale
   * port could hand a payload to a stranger.
   */
  orphans(): Watcher[] {
    return this.list().filter((w) => w.status === 'active' && !isPidAlive(w.ownerPid));
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
      ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
      ...(input.baselineIds === undefined ? {} : { baselineIds: input.baselineIds }),
      ...(input.etag === undefined ? {} : { etag: input.etag }),
      ...(input.lastModified === undefined ? {} : { lastModified: input.lastModified }),
    };
    this.write(watcher);
    return watcher;
  }

  /**
   * Merges `patch` into the record on disk.
   *
   * Read-modify-write, so it is not atomic against a concurrent writer — but
   * each record has exactly one owning session, so the only realistic racer is
   * the same process. Stated rather than discovered, the way `AppletBriefStore`
   * states its own.
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
      const expired = Date.parse(w.expiresAt) <= now;
      const finishedAt = w.firedAt ? Date.parse(w.firedAt) : null;
      const staleFinished =
        w.status !== 'active' && (finishedAt === null || now - finishedAt > keepFinishedMs);
      if (w.status === 'active' && expired) {
        this.finish(w.id, 'expired');
        continue;
      }
      if (staleFinished || (w.status !== 'active' && expired)) {
        this.remove(w.id);
        removed += 1;
      }
    }
    return removed;
  }

  private write(w: Watcher): void {
    atomicWriteFileSync(this.file(w.id), JSON.stringify(w, null, 2), { mode: 0o600 });
  }
}
