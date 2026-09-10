import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as realFs from 'node:fs';
import * as path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * The two `catch` arms in `work-queue.ts` that only a hostile filesystem reaches.
 *
 * Its own file because both need `node:fs` partially mocked, which the main suite
 * must not be — every other property there is measured against a real directory.
 * `vi.spyOn(fs, …)` cannot do it: the ESM namespace object refuses redefinition
 * ("Cannot redefine property"), which is what sent an earlier attempt at this
 * into asserting behaviour instead of I/O.
 *
 * Worth pinning rather than trusting, because both arms defend against a
 * SILENT loss: one deletes a parked item before anyone can look at it, the other
 * reports a timestamp the code already knows is wrong.
 */

let utimesFails = false;
let statFailsIn: string | null = null;
let renameFails = false;

vi.mock('node:fs', async (orig) => {
  const actual = (await orig()) as typeof realFs;
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameFails) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      return actual.renameSync(...args);
    },
    utimesSync: (...args: Parameters<typeof actual.utimesSync>) => {
      if (utimesFails) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return actual.utimesSync(...args);
    },
    statSync: ((p: string, ...rest: unknown[]) => {
      if (statFailsIn && String(p).includes(statFailsIn)) {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
      return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.statSync,
  };
});

interface Job {
  name: string;
}
const isJob = (v: unknown): v is Job => Boolean(v) && typeof (v as Job).name === 'string';

let dir = '';
beforeEach(() => {
  utimesFails = false;
  statFailsIn = null;
  renameFails = false;
  dir = mkdtempSync(path.join(tmpdir(), 'wq-fsfail-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function queue(opts: Record<string, unknown> = {}) {
  const { WorkQueue } = await import('./work-queue.js');
  return new WorkQueue<Job>({ dir, validate: isJob, maxAgeMs: 1000, ...opts });
}

/**
 * An item that is old by NAME (which is how `sweep` dates a pending item) and old
 * by mtime (which is how `pruneParked` dates a parked one).
 *
 * Both halves are needed: without the old mtime the rewrite fallback is
 * indistinguishable from doing nothing, because `writeFileSync` would have set a
 * fresh mtime anyway. Stamped through the real `utimesSync`, since the mocked one
 * is the thing under test.
 */
function seedStale(ageMs: number): string {
  const at = Date.now() - ageMs;
  const name = `${String(at).padStart(14, '0')}-000000-stale.json`;
  realFs.mkdirSync(dir, { recursive: true });
  realFs.writeFileSync(
    path.join(dir, name),
    JSON.stringify({
      id: name.replace('.json', ''),
      enqueuedAt: new Date(at).toISOString(),
      attempts: 0,
      payload: { name: 'stale' },
    }),
  );
  realFs.utimesSync(path.join(dir, name), at / 1000, at / 1000);
  return name;
}

describe('when utimes is refused', () => {
  it('still dates the parked item from the park, not from its arrival', async () => {
    // `pruneParked` ages by mtime, and on the sweep path an item's mtime is its
    // ENQUEUE time — already past `maxAgeMs`, which is why it was parked. Without
    // the rewrite fallback the very next sweep deletes it, so the evidence the
    // `parked/` directory exists to hold is destroyed before anyone can read it.
    // Reachable on any mount that refuses `utimes` for a foreign uid.
    const q = await queue();
    seedStale(60_000);
    utimesFails = true;

    expect(q.sweep()).toMatchObject({ parked: 1, prunedParked: 0 });
    expect(q.listParked()).toHaveLength(1);
    // The assertion that fails when the fallback goes: a second sweep must not
    // find it already expired.
    expect(q.sweep().prunedParked).toBe(0);
    expect(q.listParked()).toHaveLength(1);
  });

  it('still ages it out eventually', async () => {
    // Guards the guard: a fallback that froze the clock would keep parked items
    // forever, which is the other way to break the bound this module promises.
    const q = await queue();
    seedStale(60_000);
    utimesFails = true;
    q.sweep();
    expect(q.sweep(Date.now() + 5000).prunedParked).toBe(1);
  });
});

describe('when a parked item cannot be stat-ed', () => {
  it('reports no parkedAt rather than guessing the enqueue time', async () => {
    // The enqueue time is precisely the wrong answer — it is the value the
    // explicit `utimes` exists to replace — so an unanswerable question is
    // reported as unanswered.
    const q = await queue();
    seedStale(60_000);
    q.sweep();
    statFailsIn = 'parked';

    const [listed] = q.listParked();
    expect(listed).toBeDefined();
    expect(listed.parkedAt).toBeUndefined();
  });
});

describe('when an in-place write fails', () => {
  it('leaves no temp file behind', async () => {
    // Half of why `write` uses `atomicWriteFileSyncUnique`: it unlinks its own
    // temp on failure. The fixed-suffix variant does not, and `isItemFile` keeps
    // `.tmp` out of both `count()` and the age pass — so an orphan would sit in
    // the one directory this module promises to bound, counting against nothing
    // and swept by nothing.
    //
    // The OTHER half — that two concurrent drains writing one id cannot collide
    // on a shared `<id>.json.tmp` and splice the file — is a cross-process
    // property no single-process test here can pin. `pruneTemp` exists because of
    // that, and `fs-utils.ts` carries the rule.
    const q = await queue();
    q.enqueue({ name: 'a' });
    const [item] = q.peek();
    renameFails = true;
    q.markAttempt([item]);
    renameFails = false;

    const leftovers = realFs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
