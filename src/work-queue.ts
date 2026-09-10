import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync, atomicWriteFileSyncUnique } from './fs-utils.js';

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
  /** Why the last attempt failed, when a consumer said. Set by {@link WorkQueue.retry}. */
  lastError?: string;
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

const DEFAULT_MAX_PENDING = 200;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How often a long-lived process re-applies retention. See `ensureSwept`. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Width of the zero-padded epoch prefix {@link WorkQueue.enqueue} writes. */
const EPOCH_PREFIX_LEN = 14;

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

/**
 * When an item was enqueued, read straight off its name.
 *
 * `enqueue` zero-pads `Date.now()` into the first {@link EPOCH_PREFIX_LEN}
 * characters precisely so the directory sorts in arrival order, which means the
 * age question is already answered without opening anything. `sweep` asks it of
 * every pending file, and reading each one to parse `enqueuedAt` instead cost
 * 3.34 ms at 200 pending against 0.26 ms here — for a number the filename was
 * carrying all along. `NaN` for a name from some other writer, which `sweep`
 * treats as unaged rather than as infinitely old: a name it cannot read is not
 * evidence that the item is stale.
 */
function enqueuedAtFromName(name: string): number {
  const prefix = name.slice(0, EPOCH_PREFIX_LEN);
  return /^\d+$/.test(prefix) ? Number(prefix) : Number.NaN;
}

export class WorkQueue<T> {
  private readonly dir: string;
  private readonly parkedDir: string;
  private readonly validate: (value: unknown) => value is T;
  private readonly maxPending: number;
  private readonly maxAttempts: number;
  private readonly maxAgeMs: number;
  private sweptAt = 0;

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
   * `<epochMs>-<seq>-<uuid>.json`, so a lexical sort of the directory IS arrival
   * order and {@link peek} needs no `stat` — `inbox/send.ts`'s naming, for its
   * reason. The epoch prefix is zero-padded so the ordering survives the year
   * 2286.
   *
   * **A full queue refuses the newest item rather than evicting the oldest**,
   * which is the opposite direction from {@link sweep}'s over-cap branch, and
   * both are deliberate: refusing is what keeps the starving item at the head
   * from being the one thrown away, while a backlog that somehow got over the cap
   * is recovered from the oldest end because those items are closest to expiry
   * anyway. Since a refusal means the length never exceeds the cap, that branch
   * is a recovery path — a cap lowered between versions, or two writers racing —
   * not the steady state.
   */
  enqueue(payload: T): string | null {
    // Measured end to end on real 2.6 KB rows, medians of 400:
    //
    //   depth     0    52   200   500   (pending items)
    //   enqueue  .129  .150  .209  .347  ms
    //   readdir  .004  .023  .076  .200  ms   <- the cap's listing
    //
    // against 0.0075 ms for `appendJsonlBounded`. The one structural fact is that
    // **the listing is the only term that scales** — the 2.6 KB atomic write is
    // flat at 0.030 ms from 0 to 500 files — so it is a minority of the cost at
    // the depth a real install reaches (15% at the busiest five-minute window
    // measured, 52 dispatches) and the majority only near the 500 cap.
    //
    // Deliberately NOT presented as a breakdown: the named components sum to
    // ~0.043 ms against 0.129 measured, and the remainder is not attributed here.
    // An earlier version of this comment did claim a breakdown, picked the
    // dominant term from it, and was wrong in both directions. If you re-measure,
    // replace these numbers rather than reasoning from the gap.
    //
    // Either way it is noise on the return path of a dispatch that cost seconds,
    // which is why the count is not cached — see the note below, and
    // `CorrectionCandidateStore` for what caching it bought. The 25.7 ms rotation
    // mattered because it was 25 ms, not because it was per-dispatch.
    try {
      this.ensureSwept();
      // `mkdirSync` every time, deliberately. A "directory already created this
      // process" cache is what `jsonl.ts` does and it is a correctness hazard
      // here: this directory is EMPTIED by a drain and by tests, so a cached
      // `true` makes every later enqueue fail silently. It also bought nothing —
      // measured, `mkdirSync` is 0.002 ms of enqueue's 0.128 ms.
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      // Counted rather than cached. `CorrectionCandidateStore` kept an in-memory
      // tally to make this O(1), which is a single-process optimisation that is
      // wrong by construction the moment a second writer exists — it is primed
      // once in a constructor and never re-synced.
      if (this.count() >= this.maxPending) return null;
      const id = `${String(Date.now()).padStart(EPOCH_PREFIX_LEN, '0')}-${String(seq++).padStart(6, '0')}-${randomUUID()}`;
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
   * The oldest `limit` readable items, oldest first, **without** touching them.
   *
   * Split out from {@link claim} because a consumer may not process everything it
   * has to read. Recall groups by specialist and renders until a character
   * budget, so the items past that budget were never shown to a model — and while
   * `claim` counted an attempt against all of them, three sessions of that parked
   * work nobody had looked at. Replaying the last 52 real dispatches: 52 claimed
   * to acknowledge 19, then 33 to acknowledge 13, then 17 parked unprocessed.
   * That is the marker's loss again, with a paper trail.
   *
   * So the rule is now: **read freely, and count an attempt only against what you
   * are about to run.** {@link markAttempt} is the other half.
   *
   * An item already at `maxAttempts`, or one this build cannot parse, is parked
   * here rather than returned — neither is work, and a reader is the only pass
   * that can notice.
   */
  peek(limit = Number.POSITIVE_INFINITY): Array<QueueItem<T>> {
    this.ensureSwept();
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
        this.park(name, item);
        continue;
      }
      out.push(item);
    }
    return out;
  }

  /**
   * Records durably that these items are about to be attempted.
   *
   * **Call it before handing the work to anything that can crash**, which is the
   * whole property: the increment survives whether or not the consumer returns,
   * so an item that kills a drain cannot be retried forever. That is the
   * difference from a lease, which would need a clock and an expiry this does
   * not. Returns the items as they now are, so a caller can keep using them.
   */
  markAttempt(items: Array<QueueItem<T>>): Array<QueueItem<T>> {
    const out: Array<QueueItem<T>> = [];
    for (const item of items) {
      const marked = { ...item, attempts: item.attempts + 1 };
      if (this.write(`${item.id}.json`, marked)) out.push(marked);
    }
    return out;
  }

  /**
   * {@link peek} plus {@link markAttempt}, for a consumer that processes
   * everything it takes.
   *
   * Which is corrections: it asks for `MAX_CORRECTIONS_PER_RUN` and runs all of
   * them. A consumer whose batch size is decided after reading — recall, whose
   * budget is in characters — wants the two halves separately.
   */
  claim(limit = Number.POSITIVE_INFINITY): Array<QueueItem<T>> {
    return this.markAttempt(this.peek(limit));
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
   * The attempt was already counted by {@link markAttempt}, so this only persists
   * the reason — and parks the item when the count is spent, which is what stops
   * a permanently failing payload costing a model call every session forever.
   */
  retry(id: string, error?: string): void {
    const name = `${id}.json`;
    const item = this.read(name);
    if (!item) return;
    if (item.attempts >= this.maxAttempts) {
      this.park(name, item, error);
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
   * are the oldest, for the reason {@link enqueue} gives.
   *
   * Reads nothing: a pending item's age is in its name and a parked one's is its
   * mtime. That is what makes it cheap enough to run from {@link ensureSwept}
   * rather than from a call site somebody has to remember.
   */
  sweep(now = Date.now()): { parked: number; prunedParked: number; prunedTemp: number } {
    let parked = 0;
    const names = this.names();
    const aged = new Set<string>();
    for (const name of names) {
      const at = enqueuedAtFromName(name);
      // `NaN` — a name this module did not write — is left alone rather than
      // treated as infinitely old. A file we cannot date is not evidence that it
      // is stale, and the cap below still bounds the directory either way.
      if (Number.isFinite(at) && now - at > this.maxAgeMs) {
        if (this.park(name, undefined, undefined, now)) {
          parked++;
          aged.add(name);
        }
      }
    }
    const over = names.length - aged.size - this.maxPending;
    if (over > 0) {
      let dropped = 0;
      for (const name of names) {
        if (dropped >= over) break;
        if (aged.has(name)) continue;
        if (this.park(name, undefined, undefined, now)) {
          parked++;
          dropped++;
        }
      }
    }
    return {
      parked,
      prunedParked: this.pruneParked(now),
      prunedTemp: this.pruneTemp(now),
    };
  }

  /**
   * How many items are waiting. Excludes parked ones, which are not work.
   *
   * Sweeps first, which is not incidental: `runCorrectionAgent` asks this and
   * returns early on zero, so a queue whose pending set is empty while its
   * `parked/` is full would otherwise never reach a sweep on any path, in any
   * process.
   */
  pending(): number {
    this.ensureSwept();
    return this.count();
  }

  /**
   * Parked items, for a surface that wants to show what could not be processed.
   *
   * **Nothing reads this yet**, and that is worth stating rather than leaving to
   * be discovered: `parked/` plus `lastError` is an audit trail with no reader,
   * which is the same shape as the four `CorrectionCandidateStore` statuses this
   * module deleted for being exactly that. The difference is that these are
   * bounded — {@link sweep} ages them out — so the failure mode is "nobody
   * looked", not "the directory grew forever". The reader that would earn its keep
   * is a failure count on the thing a user already opens (`ToolProfile` carries
   * `errorCount`/`dismissed` and `bernard tool-profiles` prints it), not a second
   * listing command.
   *
   * `parkedAt` comes off the file's mtime rather than a stored field, and is
   * OPTIONAL: when the `stat` fails there is no honest answer, and the enqueue
   * time is a worse one than none — it is the value the explicit `utimes` in
   * {@link park} exists to replace. Stored, it could only be written by the two
   * park paths that already hold the item — {@link sweep} deliberately holds
   * none — so the field was there or not depending on WHY an item was parked,
   * which is the most misleading state available. mtime is what
   * {@link pruneParked} ages against anyway, so this is the same number rather
   * than a second one that can disagree.
   */
  listParked(): Array<QueueItem<T> & { parkedAt?: string }> {
    const out: Array<QueueItem<T> & { parkedAt?: string }> = [];
    for (const name of this.namesIn(this.parkedDir)) {
      const item = this.read(name, this.parkedDir);
      if (!item) continue;
      let parkedAt: string | undefined;
      try {
        parkedAt = new Date(fs.statSync(path.join(this.parkedDir, name)).mtimeMs).toISOString();
      } catch {
        // Vanished under us. Left undefined rather than guessed.
      }
      out.push({ ...item, ...(parkedAt ? { parkedAt } : {}) });
    }
    return out;
  }

  /**
   * Retention, applied once per process at the first use of the queue.
   *
   * **Not a call site.** The predecessor swept from `index.ts`, which meant the
   * correction queue — the one whose 54 measured rows are half the reason this
   * module exists — was never swept at all, because only the recall queue's line
   * got written. Retention is a property of a queue, so the queue applies it, and
   * the third adopter cannot silently get none. Hung off `enqueue` as well as
   * {@link peek} so a queue nobody drains (corrections, with
   * `correctionEnabled: false`) is still bounded.
   *
   * It also moves ~3 ms of synchronous `readdir`-and-parse off the startup path,
   * where it sat 187 lines before `render()` and so was pure time-to-first-paint.
   *
   * **A timestamp, not a boolean**, because these queues are memoised at module
   * scope and the cron daemon and the applet host hold one for days. A once-per-
   * instance latch means that for the whole life of such a process nothing ages
   * pending items out and — the part that actually grows — nothing prunes
   * `parked/`, where every spent retry and every unparseable row lands. `sweep`
   * reads no files and measures 0.26 ms at 200 items, so re-arming hourly costs
   * nothing and is what makes "retention is a property of a queue" true for a
   * process that stays up rather than only for one that restarts.
   */
  private ensureSwept(): void {
    const now = Date.now();
    if (now - this.sweptAt < SWEEP_INTERVAL_MS) return;
    this.sweptAt = now;
    try {
      this.sweep(now);
    } catch {
      // Housekeeping must never be why a producer or a drain fails.
    }
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

  /** The length of {@link names} without paying for the sort nobody asked for. */
  private count(): number {
    try {
      let n = 0;
      for (const name of fs.readdirSync(this.dir)) if (isItemFile(name)) n++;
      return n;
    } catch {
      return 0;
    }
  }

  private read(name: string, dir = this.dir): QueueItem<T> | null {
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
      return parsed as QueueItem<T>;
    } catch {
      return null;
    }
  }

  /**
   * Rewrites one item in place.
   *
   * **`atomicWriteFileSyncUnique`, not the fixed-suffix variant**, which is the
   * rule `fs-utils.ts` states for exactly this situation: a shared `<name>.tmp`
   * means two concurrent writers write one temp file and rename it twice.
   * {@link enqueue} can use the plain variant because its target name carries a
   * UUID, so its temp name is unique too — but every path through here addresses
   * an id a SECOND drain can be holding at the same moment (a REPL closing while
   * the cron daemon closes, or two REPLs). Interleaved, the fixed suffix yields a
   * spliced `<id>.json`, which `read` then rejects and the next `peek` parks as
   * "a payload this build cannot read": the work is dropped and the parked
   * evidence blames the payload for a writer race. The unique variant also
   * unlinks its own temp on failure, so a failed write leaves nothing behind —
   * `isItemFile` excludes `.tmp` from both `count()` and `sweep`, so an orphan
   * would otherwise sit in the queue directory permanently.
   *
   * **What this does NOT fix** is the benign half of the same race: two drains
   * that both read `attempts: n` both write `n + 1`, so N concurrent attempts
   * cost one increment and `maxAttempts` stops being a hard bound under
   * concurrency. Closing that needs a compare-and-swap this has no primitive for;
   * {@link sweep}'s age bound is what still terminates such an item.
   */
  private write(name: string, item: QueueItem<T>): boolean {
    try {
      return (
        atomicWriteFileSyncUnique(path.join(this.dir, name), JSON.stringify(item), {
          mode: 0o600,
        }) === null
      );
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
   *
   * Rewrites the file only to persist an `error` the caller supplied, using the
   * `item` the caller already holds rather than re-reading it. **When** it was
   * parked is carried by the mtime instead of a stored field, and the
   * `utimesSync` is what makes that true on every path: a rename does NOT touch
   * mtime, so without it an item parked for being old would arrive in `parked/`
   * still carrying its enqueue time and be deleted by the very sweep that parked
   * it — the bug that made the evidence unviewable.
   */
  private park(
    name: string,
    item?: QueueItem<T> | null,
    error?: string,
    now = Date.now(),
  ): boolean {
    const dest = path.join(this.parkedDir, name);
    try {
      fs.mkdirSync(this.parkedDir, { recursive: true, mode: 0o700 });
      if (item && error !== undefined) this.write(name, { ...item, lastError: error });
      fs.renameSync(path.join(this.dir, name), dest);
    } catch {
      return false;
    }
    try {
      const at = now / 1000;
      fs.utimesSync(dest, at, at);
    } catch {
      // **Not a cosmetic fallback.** {@link pruneParked} ages by mtime, and on the
      // `sweep` path the item's mtime is its ENQUEUE time — already past
      // `maxAgeMs`, which is why it was parked — so leaving it would have the very
      // next sweep delete it before anyone could look. Rewriting the file sets
      // mtime as a side effect, which is the same guarantee by a slower route, and
      // is reachable on any mount that refuses `utimes` for a foreign uid.
      try {
        const current = item ?? this.read(name, this.parkedDir);
        if (current) {
          atomicWriteFileSyncUnique(dest, JSON.stringify(current), { mode: 0o600 });
        }
      } catch {
        // Neither worked: the item is parked and will age from its last write,
        // which for a sweep-parked item means the next sweep removes it.
      }
    }
    return true;
  }

  /**
   * Removes temp files no write came back for.
   *
   * `atomicWriteFileSyncUnique` unlinks its own on failure, so this only ever
   * finds one left by a process that died mid-write — but `isItemFile` keeps
   * `.tmp` out of `count()` and out of the age pass, so without this the one
   * directory this module promises to bound has a second way to grow that
   * "bounds the directory by age and by count" does not cover.
   */
  private pruneTemp(now: number): number {
    let pruned = 0;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    for (const name of entries) {
      if (!name.includes('.json.') || !name.endsWith('.tmp')) continue;
      const full = path.join(this.dir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > this.maxAgeMs) {
          fs.unlinkSync(full);
          pruned++;
        }
      } catch {
        // best-effort
      }
    }
    return pruned;
  }

  /**
   * Parked items are evidence, not work, so they age out too — from when they
   * were parked, which is the file's mtime.
   *
   * mtime, set explicitly by {@link park}, rather than a field inside the file —
   * which is what lets {@link sweep} read nothing at all. Ageing by `enqueuedAt`
   * instead would delete an item parked FOR being old in the same sweep that
   * parked it, so nobody could ever see it.
   */
  private pruneParked(now: number): number {
    let pruned = 0;
    for (const name of this.namesIn(this.parkedDir)) {
      const full = path.join(this.parkedDir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > this.maxAgeMs) {
          fs.unlinkSync(full);
          pruned++;
        }
      } catch {
        // best-effort
      }
    }
    return pruned;
  }
}
