import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from './fs-utils.js';

/**
 * @module work-queue
 *
 * A directory-backed, at-least-once work queue for the passes that run at
 * session close.
 *
 * ## Why a queue rather than a cursor
 *
 * Two passes decided what to process by the weakest means available, and both
 * lost work.
 *
 * **Specialist recall** read an append-only log against a single timestamp
 * marker. #561 made the read exact and then had to hand-roll at-least-once on
 * top of it: a failed extraction dragged the one shared cursor back behind its
 * oldest entry, so every OTHER specialist newer than that point was re-processed
 * too — duplicate model calls and duplicate notes. One bookmark cannot serve N
 * independent items.
 *
 * **Corrections** was already a per-item store and had the three defects a queue
 * exists to prevent: no retry, so a provider timeout burned the item as
 * `invalid` forever; no retention, so 54 rows accumulated on a real install and
 * every listing paid for all of them; and a drain that took the NEWEST five
 * because `list()` sorted descending, so anything older starved permanently.
 *
 * "Deterministic" then falls out rather than being engineered: the set of work is
 * exactly the files present, and no comparison against a clock decides anything.
 *
 * ## What it is NOT for
 *
 * Seven timestamp-ish files exist in this tree and only one was a work cursor.
 * `MEMORY_CONSOLIDATED_MARKER` is a **change detector** over a store ("has
 * anything been written since we last looked?"), the fact-extraction and
 * detector arms take one whole transcript per session, `.seeded-*` are existence
 * markers, `last-session.txt` is a decay date and `update-check.json` is a TTL
 * cache. None of them is a queue, and conflating them is the mistake this module
 * is shaped to avoid.
 */

/** One unit of work, as it sits on disk. */
export interface QueueItem<T> {
  /** The file's stem, which is also its arrival key. */
  id: string;
  enqueuedAt: string;
  /** How many times a drain has taken this item and not finished it. */
  attempts: number;
  payload: T;
}

export interface WorkQueueOptions<T> {
  dir: string;
  /**
   * Whether a parsed file is a payload of this queue's type.
   *
   * The `PerTurnStore<T>` idiom: the queue never learns what `T` is, and a row
   * written by an older build that no longer validates is dropped rather than
   * handed to a consumer that cannot read it.
   */
  validate: (value: unknown) => value is T;
  /** Undelivered items past which `enqueue` refuses. Backpressure that also bounds disk. */
  maxPending?: number;
  /** Attempts after which an item is parked rather than claimed again. */
  maxAttempts?: number;
  /** Age past which `sweep` drops an item nobody drained. */
  maxAgeMs?: number;
}

/**
 * Monotonic within a process, so two items enqueued in the same millisecond
 * still sort in arrival order.
 *
 * `inbox/send.ts` uses `<epochMs>-<uuid>` and tolerates the tie because a
 * notice's order among simultaneous arrivals does not matter. Here it does:
 * oldest-first is the property that fixes corrections' starvation, and a random
 * UUID deciding ties makes "oldest" a coin flip for every burst — four items
 * enqueued in a loop sorted `n1, n3, n0, n2` in practice. Across processes the
 * millisecond still decides and a tie is arbitrary, which is honest: those items
 * really did arrive together.
 */
let seq = 0;

/**
 * Queue directories already created this process, so an enqueue is not a
 * `mkdirSync` every time. `jsonl.ts`'s `readyDirs` exactly, for its reason.
 */
const readyDirs = new Set<string>();

const DEFAULT_MAX_PENDING = 200;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Only files named exactly `*.json` are items.
 *
 * Load-bearing, not tidiness, and the inbox says the same thing about its own
 * drain: `atomicWriteFileSync` writes `<name>.tmp` **in the directory being
 * read** and then renames it, so a predicate that accepted anything not starting
 * with a dot would read half-written files. Do not "simplify" this.
 */
function isItemFile(name: string): boolean {
  return name.endsWith('.json');
}

export class WorkQueue<T> {
  private readonly dir: string;
  private readonly parkedDir: string;
  private readonly validate: (value: unknown) => value is T;
  private readonly maxPending: number;
  private readonly maxAttempts: number;
  private readonly maxAgeMs: number;

  constructor(opts: WorkQueueOptions<T>) {
    this.dir = opts.dir;
    this.parkedDir = path.join(opts.dir, 'parked');
    this.validate = opts.validate;
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /**
   * Adds one item, or returns `null` when the queue is full or the write failed.
   *
   * **Never throws.** Both producers sit on a dispatch's return path and already
   * state the rule: recording work must not break the work. A refusal is
   * deliberately indistinguishable from a failure to the caller, because neither
   * is actionable there.
   *
   * `<epochMs>-<uuid>.json`, so a lexical sort of the directory IS arrival order
   * and {@link claim} needs no `stat` — `inbox/send.ts`'s naming, for its reason.
   * The epoch prefix is zero-padded so the ordering survives the year 2286.
   */
  enqueue(payload: T): string | null {
    // Measured: 0.128 ms at an empty queue and 0.199 ms at 199 pending, against
    // 0.0075 ms for `appendJsonlBounded`. Most of it is the temp-write-and-rename
    // rather than the cap's `readdir`, and all of it is noise on the return path
    // of a dispatch that cost seconds — the 25.7 ms rotation mattered because it
    // was 25 ms, not because it was per-dispatch.
    try {
      if (!readyDirs.has(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        readyDirs.add(this.dir);
      }
      // Counted rather than cached. `CorrectionCandidateStore` kept an in-memory
      // tally to make this O(1), which is a single-process optimisation that is
      // wrong by construction the moment a second writer exists — it is primed
      // once in a constructor and never re-synced.
      if (this.names().length >= this.maxPending) return null;
      const id = `${String(Date.now()).padStart(14, '0')}-${String(seq++).padStart(6, '0')}-${randomUUID()}`;
      const item: QueueItem<T> = {
        id,
        enqueuedAt: new Date().toISOString(),
        attempts: 0,
        payload,
      };
      atomicWriteFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(item), { mode: 0o600 });
      return id;
    } catch {
      return null;
    }
  }

  /**
   * The oldest `limit` items, oldest first, with `attempts` already incremented.
   *
   * **Claiming bumps the attempt count before the consumer runs**, so an item
   * that makes a drain crash cannot be retried forever: the increment is durable
   * whether or not the consumer returns. That is the difference from a lease,
   * which would need a clock and an expiry this does not.
   *
   * An item already at `maxAttempts` is parked here rather than handed out, so a
   * poison row leaves the working set on the pass that would have retried it.
   */
  claim(limit = Number.POSITIVE_INFINITY): Array<QueueItem<T>> {
    const out: Array<QueueItem<T>> = [];
    for (const name of this.names()) {
      if (out.length >= limit) break;
      const item = this.read(name);
      // Unreadable, or a payload this build does not recognise. Parked rather
      // than deleted: a row a consumer cannot parse is the one worth looking at.
      if (!item) {
        this.park(name);
        continue;
      }
      if (item.attempts >= this.maxAttempts) {
        this.park(name);
        continue;
      }
      const claimed = { ...item, attempts: item.attempts + 1 };
      if (!this.write(name, claimed)) continue;
      out.push(claimed);
    }
    return out;
  }

  /**
   * Acknowledges one item by deleting it.
   *
   * **Deletion is the acknowledgement, and only success calls this** — the one
   * inversion from `src/inbox/`, which unlinks whatever happens because it is
   * deliberately at-most-once. These consumers need at-least-once, which is
   * exactly what #561 had to bolt onto the marker.
   */
  done(id: string): void {
    try {
      fs.unlinkSync(path.join(this.dir, `${id}.json`));
    } catch {
      // Already gone, or never there. Either way there is nothing to acknowledge.
    }
  }

  /**
   * Hands an item back, recording why.
   *
   * The attempt was already counted by {@link claim}, so this only persists the
   * reason — and parks the item when the count is spent, which is what stops a
   * permanently failing payload costing a model call every session forever.
   */
  retry(id: string, error?: string): void {
    const name = `${id}.json`;
    const item = this.read(name);
    if (!item) return;
    if (item.attempts >= this.maxAttempts) {
      this.park(name, error);
      return;
    }
    this.write(name, error === undefined ? item : { ...item, lastError: error });
  }

  /**
   * Bounds the directory by age and by count. Returns what it moved.
   *
   * The retention all four existing candidate stores lack — measured, 54
   * correction rows and 42 others sit on this install with nothing that could
   * ever remove them. Over-age items are parked rather than dropped, because an
   * item nobody drained for a week is evidence about the drain; over-cap items
   * are the oldest, for the same reason `claim` is oldest-first.
   */
  sweep(now = Date.now()): { parked: number; prunedParked: number } {
    let parked = 0;
    const names = this.names();
    for (const name of names) {
      const item = this.read(name);
      const age = item ? now - Date.parse(item.enqueuedAt) : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(age) || age > this.maxAgeMs) {
        if (this.park(name, undefined, now)) parked++;
      }
    }
    const over = this.names().length - this.maxPending;
    if (over > 0) {
      for (const name of this.names().slice(0, over)) {
        if (this.park(name, undefined, now)) parked++;
      }
    }
    return { parked, prunedParked: this.pruneParked(now) };
  }

  /** How many items are waiting. Excludes parked ones, which are not work. */
  pending(): number {
    return this.names().length;
  }

  /** Parked items, for a surface that wants to show what could not be processed. */
  listParked(): Array<QueueItem<T> & { lastError?: string; parkedAt?: string }> {
    const out: Array<QueueItem<T> & { lastError?: string; parkedAt?: string }> = [];
    for (const name of this.namesIn(this.parkedDir)) {
      const item = this.read(name, this.parkedDir);
      if (item) out.push(item);
    }
    return out;
  }

  /**
   * Arrival order, which is filename order — see {@link enqueue}.
   *
   * `[]` on an unreadable directory, because every caller is asking "what is
   * there?" and an unreadable queue has nothing in it that can be worked on.
   */
  private names(): string[] {
    return this.namesIn(this.dir);
  }

  private namesIn(dir: string): string[] {
    try {
      return fs.readdirSync(dir).filter(isItemFile).sort();
    } catch {
      return [];
    }
  }

  private read(
    name: string,
    dir = this.dir,
  ): (QueueItem<T> & { lastError?: string; parkedAt?: string }) | null {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof (parsed as QueueItem<T>).id !== 'string' ||
        typeof (parsed as QueueItem<T>).attempts !== 'number' ||
        !this.validate((parsed as QueueItem<T>).payload)
      ) {
        return null;
      }
      return parsed as QueueItem<T> & { lastError?: string; parkedAt?: string };
    } catch {
      return null;
    }
  }

  private write(
    name: string,
    item: QueueItem<T> & { lastError?: string; parkedAt?: string },
  ): boolean {
    try {
      atomicWriteFileSync(path.join(this.dir, name), JSON.stringify(item), { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Moves an item out of the working set, keeping it readable.
   *
   * A rename rather than a status field, because the question every caller asks
   * is "what is still work?" and a directory answers it without parsing
   * anything. It is also why there is no `status` enum here at all: the four
   * `CorrectionCandidateStore` terminals were an audit trail nothing read and
   * nothing ever compacted.
   */
  private park(name: string, error?: string, now = Date.now()): boolean {
    try {
      fs.mkdirSync(this.parkedDir, { recursive: true, mode: 0o700 });
      // Stamped on the way out, and the stamp is what `pruneParked` ages
      // against. Ageing a parked item by `enqueuedAt` would delete an item
      // parked FOR being old in the same sweep that parked it, so nobody could
      // ever see it.
      const item = this.read(name);
      if (item) {
        this.write(name, {
          ...item,
          parkedAt: new Date(now).toISOString(),
          ...(error === undefined ? {} : { lastError: error }),
        });
      }
      fs.renameSync(path.join(this.dir, name), path.join(this.parkedDir, name));
      return true;
    } catch {
      return false;
    }
  }

  /** Parked items are evidence, not work, so they age out too — from when they were parked. */
  private pruneParked(now: number): number {
    let pruned = 0;
    for (const name of this.namesIn(this.parkedDir)) {
      try {
        const item = this.read(name, this.parkedDir);
        const since = item?.parkedAt ? Date.parse(item.parkedAt) : Number.NaN;
        // An item with no readable stamp is pruned: it is unreadable evidence.
        if (!Number.isFinite(since) || now - since > this.maxAgeMs) {
          fs.unlinkSync(path.join(this.parkedDir, name));
          pruned++;
        }
      } catch {
        // best-effort
      }
    }
    return pruned;
  }
}
