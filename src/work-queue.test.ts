import { describe, it, expect } from 'vitest';
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

  it('ignores a half-written temp file in its own directory', () => {
    // Load-bearing: `atomicWriteFileSync` writes `<name>.tmp` in the directory
    // being read. A looser predicate reads half-written items.
    const q = make();
    q.enqueue({ name: 'a' });
    fs.writeFileSync(path.join(dirOf(), 'x.json.tmp'), '{"not":');
    expect(q.claim().map((i) => i.payload.name)).toEqual(['a']);
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
