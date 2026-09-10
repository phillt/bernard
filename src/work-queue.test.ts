import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from './__tests__/temp-home.js';
import { WorkQueue } from './work-queue.js';

/**
 * The properties a cursor over a log could not have.
 *
 * Real disk, because every one of them is about what survives a process — the
 * harness `memory-candidates.test.ts` uses, since nothing in the tree drives two
 * real processes.
 */
const home = useTempHome('work-queue');

interface Job {
  name: string;
}
const isJob = (v: unknown): v is Job => Boolean(v) && typeof (v as Job).name === 'string';

const dirOf = () => path.join(home(), 'queue');
const make = (over: Partial<ConstructorParameters<typeof WorkQueue>[0]> = {}) =>
  new WorkQueue<Job>({ dir: dirOf(), validate: isJob, ...over });

const names = () =>
  fs
    .readdirSync(dirOf())
    .filter((n) => n.endsWith('.json'))
    .sort();
const parked = () => {
  try {
    return fs.readdirSync(path.join(dirOf(), 'parked')).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
};

describe('enqueue', () => {
  it('creates the directory and one file per item', () => {
    const q = make();
    expect(q.enqueue({ name: 'a' })).toBeTruthy();
    expect(q.enqueue({ name: 'b' })).toBeTruthy();
    expect(names()).toHaveLength(2);
    expect(q.pending()).toBe(2);
  });

  it('returns null rather than throwing when full', () => {
    // Both producers sit on a dispatch's return path: recording work must not
    // break the work, so a refusal is a return value and never an exception.
    const q = make({ maxPending: 2 });
    q.enqueue({ name: 'a' });
    q.enqueue({ name: 'b' });
    expect(q.enqueue({ name: 'c' })).toBeNull();
    expect(q.pending()).toBe(2);
  });

  it('works again after the directory is removed under it', () => {
    // A cached "already created this process" flag — which `jsonl.ts` keeps for
    // its own append — is a correctness hazard HERE, because a drain empties this
    // directory and a test removes it. With the cache, every enqueue after the
    // first removal failed silently.
    const q = make();
    expect(q.enqueue({ name: 'a' })).toBeTruthy();
    fs.rmSync(dirOf(), { recursive: true, force: true });
    expect(q.enqueue({ name: 'b' })).toBeTruthy();
    expect(q.claim().map((i) => i.payload.name)).toEqual(['b']);
  });

  it('never throws when the directory cannot be created', () => {
    const blocker = path.join(home(), 'blocker');
    fs.writeFileSync(blocker, 'x');
    const q = new WorkQueue<Job>({ dir: path.join(blocker, 'sub'), validate: isJob });
    expect(() => q.enqueue({ name: 'a' })).not.toThrow();
    expect(q.enqueue({ name: 'a' })).toBeNull();
  });
});

describe('claim', () => {
  it('orders two items enqueued in the same millisecond by arrival', () => {
    // `inbox/send.ts`'s `<epochMs>-<uuid>` tolerates the tie because a notice's
    // order among simultaneous arrivals does not matter. Here oldest-first IS
    // the property, and a random UUID deciding ties made a four-item burst sort
    // `n1, n3, n0, n2`.
    const q = make();
    const expected = Array.from({ length: 8 }, (_, i) => `n${i}`);
    for (const name of expected) q.enqueue({ name });
    expect(q.claim().map((i) => i.payload.name)).toEqual(expected);
  });

  it('returns the OLDEST first', () => {
    // The direction that fixes corrections' starvation: its drain took the
    // newest five because `list()` sorted descending, so anything older never
    // ran again. Filename order is arrival order, so oldest-first is the cheap
    // direction here rather than the expensive one.
    const q = make();
    for (const name of ['a', 'b', 'c']) q.enqueue({ name });
    expect(q.claim(2).map((i) => i.payload.name)).toEqual(['a', 'b']);
  });

  it('honours a limit and leaves the rest queued', () => {
    const q = make();
    for (const name of ['a', 'b', 'c']) q.enqueue({ name });
    q.claim(1);
    expect(q.pending()).toBe(3);
  });

  it('counts the attempt durably, before the consumer runs', () => {
    // So an item that makes a drain CRASH cannot be retried forever — the
    // increment is on disk whether or not the consumer returns.
    const q = make();
    q.enqueue({ name: 'a' });
    expect(q.claim()[0].attempts).toBe(1);
    expect(q.claim()[0].attempts).toBe(2);
  });

  it('parks a payload this build cannot read rather than deleting it', () => {
    // A row the validator rejects is the one worth looking at.
    const q = make();
    q.enqueue({ name: 'a' });
    const file = path.join(dirOf(), names()[0]);
    fs.writeFileSync(file, JSON.stringify({ id: 'x', attempts: 0, payload: { wrong: true } }));
    expect(q.claim()).toEqual([]);
    expect(parked()).toHaveLength(1);
  });

  it('leaves a half-written temp file in its own directory completely alone', () => {
    // Load-bearing: the atomic writers put `<name>.tmp` in the directory being
    // read, so a looser predicate reads a half-written item.
    //
    // The `claim` assertion alone does NOT pin that, which is why the other two
    // are here: loosening the predicate to `!name.startsWith('.')` still returns
    // `['a']` — the temp file is listed, fails to parse, and is quietly PARKED as
    // "a payload this build cannot read", which is the failure dressed as the
    // mechanism working. What catches it is that nothing happened to the file.
    const q = make();
    q.enqueue({ name: 'a' });
    const tmp = path.join(dirOf(), 'x.json.tmp');
    fs.writeFileSync(tmp, '{"not":');
    expect(q.claim().map((i) => i.payload.name)).toEqual(['a']);
    expect(parked()).toHaveLength(0);
    expect(fs.readFileSync(tmp, 'utf-8')).toBe('{"not":');
  });
});

describe('peek vs claim', () => {
  it('peek reads without counting an attempt', () => {
    // The defect fix. `claim` counted one against everything it READ, and recall
    // reads more than it uses — `renderTranscript` stops at a character budget.
    // So every session bumped the unrendered remainder, and three sessions of
    // that parked work no model had ever seen: replaying 52 real dispatches gave
    // 52 claimed to acknowledge 19, then 33 for 13, then 17 parked unread.
    const q = make();
    q.enqueue({ name: 'a' });
    expect(q.peek()[0].attempts).toBe(0);
    expect(q.peek()[0].attempts).toBe(0);
    expect(q.peek()[0].attempts).toBe(0);
  });

  it('never parks an item that was only ever read', () => {
    // The property the whole split exists for, stated as the outcome rather than
    // as an attempt count: a consumer that reads four and processes one must
    // leave the other three exactly as they were, however many sessions run.
    const q = make({ maxAttempts: 2 });
    for (let i = 0; i < 4; i++) q.enqueue({ name: `n${i}` });
    for (let pass = 0; pass < 6; pass++) {
      const read = q.peek();
      if (read.length === 0) break;
      q.markAttempt(read.slice(0, 1));
      q.done(read[0].id);
    }
    // One acknowledged per pass, four passes' worth of work, nothing parked.
    expect(parked()).toHaveLength(0);
    expect(q.pending()).toBe(0);
  });

  it('markAttempt counts it durably, before the consumer runs', () => {
    // The crash guard, now owned by the caller that knows what it is about to
    // run: the increment is on disk whether or not the consumer returns.
    const q = make();
    q.enqueue({ name: 'a' });
    const marked = q.markAttempt(q.peek());
    expect(marked[0].attempts).toBe(1);
    expect(make().peek()[0].attempts).toBe(1);
  });

  it('claim is peek plus markAttempt, for a consumer that takes what it runs', () => {
    const q = make();
    q.enqueue({ name: 'a' });
    expect(q.claim()[0].attempts).toBe(1);
    expect(make().peek()[0].attempts).toBe(1);
  });
});

describe('acknowledgement', () => {
  it('done removes the item', () => {
    const q = make();
    const id = q.enqueue({ name: 'a' })!;
    q.done(id);
    expect(q.pending()).toBe(0);
  });

  it('retry leaves it claimable, and ONLY it', () => {
    // The property the shared cursor could not have, and the whole reason for
    // the change: retreating one marker re-did every specialist newer than the
    // failure. Here a failure costs exactly its own items.
    const q = make();
    const a = q.enqueue({ name: 'a' })!;
    q.enqueue({ name: 'b' });
    const claimed = q.claim();
    expect(claimed).toHaveLength(2);
    q.retry(a, 'provider timeout');
    q.done(claimed[1].id);
    expect(q.claim().map((i) => i.payload.name)).toEqual(['a']);
  });

  it('records why, on the item', () => {
    const q = make({ maxAttempts: 9 });
    const id = q.enqueue({ name: 'a' })!;
    q.claim();
    q.retry(id, 'provider timeout');
    const raw = JSON.parse(fs.readFileSync(path.join(dirOf(), `${id}.json`), 'utf-8'));
    expect(raw.lastError).toBe('provider timeout');
  });

  it('done on an unknown id is a no-op rather than a throw', () => {
    expect(() => make().done('nope')).not.toThrow();
  });
});

describe('parking', () => {
  it('stops claiming an item that has spent its attempts', () => {
    // What stops a permanently failing payload costing a model call every
    // session forever — which is what the marker's retreat did.
    const q = make({ maxAttempts: 2 });
    const id = q.enqueue({ name: 'a' })!;
    q.claim();
    q.retry(id, 'one');
    q.claim();
    q.retry(id, 'two');
    expect(q.claim()).toEqual([]);
    expect(q.pending()).toBe(0);
  });

  it('parks an item whose consumer never came back at all', () => {
    // The case only `claim`'s own guard covers: a drain that CRASHES between
    // claiming and acknowledging never calls `retry`, so the attempt count is
    // the only durable trace. Without the guard that item is claimed forever —
    // which is why the increment happens before the consumer runs.
    const q = make({ maxAttempts: 2 });
    q.enqueue({ name: 'a' });
    expect(q.claim()).toHaveLength(1); // attempts 1, then "crash"
    expect(q.claim()).toHaveLength(1); // attempts 2, then "crash"
    expect(q.claim()).toEqual([]);
    expect(q.listParked()).toHaveLength(1);
  });

  it('keeps a parked item readable, with its reason', () => {
    const q = make({ maxAttempts: 1 });
    const id = q.enqueue({ name: 'a' })!;
    q.claim();
    q.retry(id, 'the reason');
    const [item] = q.listParked();
    expect(item.payload.name).toBe('a');
    expect(item.lastError).toBe('the reason');
  });
});

describe('sweep', () => {
  it('parks an item nobody drained', () => {
    // The retention all four existing candidate stores lack — measured, 54
    // correction rows and 42 others sit on a real install with nothing that
    // could ever remove them.
    const q = make({ maxAgeMs: 1000 });
    q.enqueue({ name: 'old' });
    expect(q.sweep(Date.now() + 5000).parked).toBe(1);
    expect(q.pending()).toBe(0);
  });

  it('leaves a fresh item alone', () => {
    const q = make({ maxAgeMs: 60_000 });
    q.enqueue({ name: 'fresh' });
    expect(q.sweep().parked).toBe(0);
    expect(q.pending()).toBe(1);
  });

  it('drops the OLDEST when the queue is over its cap', () => {
    // Over-cap can only happen to a queue written by a build with a larger cap,
    // or by two of them. Oldest-first for `claim`'s reason.
    const q = make({ maxPending: 10, maxAgeMs: 60_000 });
    for (let i = 0; i < 4; i++) q.enqueue({ name: `n${i}` });
    const tight = make({ maxPending: 2, maxAgeMs: 60_000 });
    expect(tight.sweep().parked).toBe(2);
    expect(tight.claim().map((i) => i.payload.name)).toEqual(['n2', 'n3']);
  });

  it('does not delete an item in the same sweep that parked it', () => {
    // Ageing a parked item by `enqueuedAt` deleted it in the sweep that parked
    // it FOR being old, so nobody could ever see the evidence. `parkedAt` is
    // what the prune ages against.
    const q = make({ maxAgeMs: 1000 });
    q.enqueue({ name: 'a' });
    const out = q.sweep(Date.now() + 999_999);
    expect(out.parked).toBe(1);
    expect(out.prunedParked).toBe(0);
    expect(q.listParked()).toHaveLength(1);
  });

  it('eventually prunes parked items too', () => {
    // Parked items are evidence, not work, so they age out on the same clock —
    // or the directory this exists to bound grows a second way.
    const q = make({ maxAgeMs: 1000 });
    q.enqueue({ name: 'a' });
    const parkedAtMs = Date.now() + 5000;
    q.sweep(parkedAtMs);
    expect(q.listParked()).toHaveLength(1);
    expect(q.sweep(parkedAtMs + 2000).prunedParked).toBe(1);
    expect(q.listParked()).toHaveLength(0);
  });
});

describe('retention applies itself', () => {
  it('sweeps on first use, with no call site to forget', () => {
    // The predecessor swept from `index.ts`, which is exactly how the CORRECTION
    // queue — whose 54 measured rows are half the reason this module exists —
    // ended up never swept at all: one line was written for the recall queue and
    // the second adopter silently got none.
    const stale = make({ maxAgeMs: 1 });
    stale.enqueue({ name: 'old' });
    const nameOf = names()[0];
    // Backdate the item by rewriting it under an older arrival key, which is how
    // age is read — see `enqueuedAtFromName`.
    const old = `${String(Date.now() - 60_000).padStart(14, '0')}-000000-aaa.json`;
    fs.renameSync(path.join(dirOf(), nameOf), path.join(dirOf(), old));

    const fresh = make({ maxAgeMs: 1000 });
    // No `sweep()` call anywhere: a plain enqueue is enough.
    fresh.enqueue({ name: 'new' });
    expect(parked()).toHaveLength(1);
  });

  it('does not re-sweep on every call', () => {
    // Needs a second sweep that WOULD do something observable, or the assertion
    // is vacuous: a fresh item makes every later sweep a no-op by construction,
    // so the predecessor of this test stayed green with the latch deleted
    // outright. Here the backdated item arrives AFTER the first sweep, so it is
    // still pending iff the latch held.
    const q = make({ maxAgeMs: 1000 });
    q.enqueue({ name: 'a' });
    q.peek();

    const old = `${String(Date.now() - 60_000).padStart(14, '0')}-000000-bbb.json`;
    fs.writeFileSync(
      path.join(dirOf(), old),
      JSON.stringify({
        id: old.replace('.json', ''),
        enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
        attempts: 0,
        payload: { name: 'stale' },
      }),
    );
    q.peek();
    expect(parked()).toHaveLength(0);
    // A fresh instance has not swept yet, so it does — which is what proves the
    // item really was sweepable and the assertion above meant something.
    make({ maxAgeMs: 1000 }).peek();
    expect(parked()).toHaveLength(1);
  });

  it('re-arms, so a process that stays up keeps applying retention', () => {
    // Once per INSTANCE is wrong for the processes that hold one: `recallQueue()`
    // and `correctionQueue()` memoise at module scope, and the cron daemon and the
    // applet host run for days. For that whole time nothing aged pending items
    // out and — the part that grows — nothing pruned `parked/`.
    vi.useFakeTimers();
    try {
      const q = make({ maxAgeMs: 1000 });
      // Arms the latch on an empty directory, so the only thing the later sweeps
      // can act on is the backdated item below — advancing the clock would
      // otherwise age an ordinary `enqueue` too and the count would not say which
      // sweep did what.
      q.peek();

      const stale = `${String(Date.now() - 60_000).padStart(14, '0')}-000000-ccc.json`;
      fs.mkdirSync(dirOf(), { recursive: true });
      fs.writeFileSync(
        path.join(dirOf(), stale),
        JSON.stringify({
          id: stale.replace('.json', ''),
          enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
          attempts: 0,
          payload: { name: 'stale' },
        }),
      );
      q.peek();
      expect(parked()).toHaveLength(0);

      vi.advanceTimersByTime(61 * 60 * 1000);
      q.peek();
      expect(parked()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sweeps from pending(), which is the only call a drain may make', () => {
    // `runCorrectionAgent` asks `pending()` and returns early on zero, so a queue
    // whose pending set is empty while its `parked/` is full would otherwise never
    // reach a sweep on any path, in any process.
    const stale = `${String(Date.now() - 60_000).padStart(14, '0')}-000000-ddd.json`;
    fs.mkdirSync(dirOf(), { recursive: true });
    fs.writeFileSync(
      path.join(dirOf(), stale),
      JSON.stringify({
        id: stale.replace('.json', ''),
        enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
        attempts: 0,
        payload: { name: 'stale' },
      }),
    );
    expect(make({ maxAgeMs: 1000 }).pending()).toBe(0);
    expect(parked()).toHaveLength(1);
  });

  it('prunes a temp file nothing came back for', () => {
    // `isItemFile` keeps `.tmp` out of `count()` and out of the age pass, so
    // without this the directory this module promises to bound has a second way
    // to grow that "by age and by count" does not cover.
    const q = make({ maxAgeMs: 1000 });
    q.enqueue({ name: 'a' });
    const orphan = path.join(dirOf(), 'something.json.1234.abcd.tmp');
    fs.writeFileSync(orphan, '{"half":');
    expect(q.sweep(Date.now() + 5000).prunedTemp).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('ages a pending item by its NAME, not by opening it', () => {
    // Asserted as behaviour rather than as a syscall count: the body is garbage,
    // so a sweep that read it would get no `enqueuedAt` at all. The name still
    // says when it arrived, and that is the number it has to use — reading each
    // item to parse the field instead cost 3.34 ms at 200 pending against 0.26 ms
    // here, on a pass that used to run before first paint.
    const q = make({ maxAgeMs: 1000 });
    q.enqueue({ name: 'a' });
    const [only] = names();
    fs.writeFileSync(path.join(dirOf(), only), 'not json at all');

    // Fresh by its name: kept, even though nothing in it is parseable. The
    // predecessor read the file, got `NaN` and treated that as infinitely old —
    // so this item was parked on the first sweep.
    expect(q.sweep(Date.now()).parked).toBe(0);
    // Old by its name: parked, on the strength of the name alone.
    expect(make({ maxAgeMs: 1000 }).sweep(Date.now() + 5000).parked).toBe(1);
  });

  it('leaves a name it did not write alone rather than calling it infinitely old', () => {
    // `NaN` age, because the prefix is not an epoch. Treating that as stale would
    // park a file some other writer put here, which is a claim this module cannot
    // support — and the cap still bounds the directory either way.
    const q = make({ maxAgeMs: 1 });
    fs.mkdirSync(dirOf(), { recursive: true });
    fs.writeFileSync(
      path.join(dirOf(), 'handwritten.json'),
      JSON.stringify({
        id: 'x',
        enqueuedAt: new Date(0).toISOString(),
        attempts: 0,
        payload: { name: 'x' },
      }),
    );
    expect(q.sweep(Date.now() + 999_999).parked).toBe(0);
  });

  it('dates a parked item from when it was parked, not when it arrived', () => {
    // A rename does not touch mtime, so without the explicit `utimes` an item
    // parked FOR being old would arrive in `parked/` still carrying its enqueue
    // time and be deleted by the very sweep that parked it.
    const q = make({ maxAgeMs: 1000 });
    q.enqueue({ name: 'a' });
    const at = Date.now() + 999_999;
    expect(q.sweep(at)).toMatchObject({ parked: 1, prunedParked: 0 });
    const [listed] = q.listParked();
    expect(Date.parse(String(listed.parkedAt))).toBeCloseTo(at, -4);
  });
});

describe('across a process boundary', () => {
  it('a second instance sees what the first enqueued, in order', async () => {
    // The whole point of a file-backed queue: the producer is the REPL and the
    // consumer is a detached worker.
    const producer = make();
    for (const name of ['first', 'second']) producer.enqueue({ name });
    const { vi } = await import('vitest');
    vi.resetModules();
    const { WorkQueue: Fresh } = await import('./work-queue.js');
    const consumer = new Fresh<Job>({ dir: dirOf(), validate: isJob });
    expect(consumer.claim().map((i) => i.payload.name)).toEqual(['first', 'second']);
  });

  it('reports nothing for a queue that does not exist yet', () => {
    const q = new WorkQueue<Job>({ dir: path.join(home(), 'never'), validate: isJob });
    expect(q.pending()).toBe(0);
    expect(q.claim()).toEqual([]);
    expect(() => q.sweep()).not.toThrow();
  });
});
