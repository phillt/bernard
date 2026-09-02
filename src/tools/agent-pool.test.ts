import { describe, it, expect, beforeEach } from 'vitest';
import {
  withSlot,
  withUncappedSlot,
  getActiveCount,
  getMaxConcurrentAgents,
  setMaxConcurrentAgents,
  slotStatusLine,
  _resetPool,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  MAX_CONCURRENT_AGENTS_LIMIT,
} from './agent-pool.js';

/** Holds a slot until `release()` is called — lets a test fill the pool. */
function hold(): { released: Promise<unknown>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const released = withSlot(
    async (slot) => {
      await gate;
      return slot;
    },
    () => null,
  );
  return { released, release };
}

/** `withSlot` with a sentinel fallback, for asserting acquired-vs-not. */
const EXHAUSTED = Symbol('exhausted');
function tryAcquire<T>(fn: (slot: { id: number }) => Promise<T>) {
  return withSlot(fn, () => EXHAUSTED as unknown as T);
}

describe('agent-pool', () => {
  beforeEach(() => {
    _resetPool();
  });

  it('hands each concurrent run an incrementing id', async () => {
    const a = hold();
    const b = hold();
    expect(getActiveCount()).toBe(2);
    a.release();
    b.release();
    expect(await a.released).toEqual({ id: 1 });
    expect(await b.released).toEqual({ id: 2 });
  });

  it('calls onExhausted at capacity, and never runs the body', async () => {
    const cap = getMaxConcurrentAgents();
    const held = Array.from({ length: cap }, () => hold());
    expect(getActiveCount()).toBe(cap);

    let ran = false;
    const out = await withSlot(
      async () => {
        ran = true;
        return 'x';
      },
      () => 'full',
    );
    expect(out).toBe('full');
    expect(ran).toBe(false);

    held.forEach((h) => h.release());
    await Promise.all(held.map((h) => h.released));
  });

  it('releases on the way out, allowing re-acquisition', async () => {
    const cap = getMaxConcurrentAgents();
    const held = Array.from({ length: cap }, () => hold());
    expect(await tryAcquire(async () => 1)).toBe(EXHAUSTED);

    held[0].release();
    await held[0].released;
    expect(getActiveCount()).toBe(cap - 1);
    expect(await tryAcquire(async () => 1)).toBe(1);

    held.slice(1).forEach((h) => h.release());
    await Promise.all(held.slice(1).map((h) => h.released));
  });

  it('releases even when the body throws', async () => {
    await expect(
      withSlot(
        async () => {
          throw new Error('boom');
        },
        () => null,
      ),
    ).rejects.toThrow('boom');
    expect(getActiveCount()).toBe(0);
  });

  it('withUncappedSlot runs even with no slot held and a full pool (#305)', async () => {
    // The main agent holds NO pool slot, so a `delegate_*` call it issues is not
    // ALS-nested. Routing that through the capped path would let parallel
    // sub-agents starve main's own MCP access.
    setMaxConcurrentAgents(1);
    const held = hold();
    expect(await tryAcquire(async () => 'capped')).toBe(EXHAUSTED);
    expect(await withUncappedSlot(async (slot) => slot.id)).toBe(2);
    held.release();
    await held.released;
    expect(getActiveCount()).toBe(0);
  });

  it('lets a nested helper through a full pool (#305)', async () => {
    // Sub-agents carry `delegate_*` tools, so a sub-agent holds a slot AND needs
    // a helper. Counting both against one flat cap starves every helper the
    // moment parallel sub-agents fill the pool — the delegate call degrades to
    // an error string and the sub-agent silently loses MCP access.
    setMaxConcurrentAgents(1);
    const outcome = await tryAcquire(async () => {
      // Pool is now full for ordinary dispatches...
      expect(getActiveCount()).toBe(1);
      // ...but a helper spawned from inside this slot goes through, because
      // #317 infers nesting from the ALS rather than a flag the caller passes.
      return tryAcquire(async (slot) => {
        // Still counted, so release stays symmetric and getActiveCount is truthful.
        expect(getActiveCount()).toBe(2);
        return slot.id;
      });
    });
    expect(outcome).toBe(2);
    expect(getActiveCount()).toBe(0);
  });

  it('does NOT leak the nested bypass to a sibling of a slot-holder', async () => {
    // The invariant that makes the ALS the right mechanism and
    // `getCurrentDispatchId()` the wrong one: every tool executes inside its
    // parent's dispatch context, so keying on that would exempt every ordinary
    // acquire. Only code running INSIDE a slot may nest — a caller that merely
    // ran alongside one must still be capped.
    setMaxConcurrentAgents(1);
    const holder = hold();
    expect(getActiveCount()).toBe(1);

    expect(await tryAcquire(async () => 'should not run')).toBe(EXHAUSTED);

    holder.release();
    await holder.released;
  });

  it('resets state completely', async () => {
    const a = hold();
    const b = hold();
    a.release();
    b.release();
    await Promise.all([a.released, b.released]);
    _resetPool();
    expect(getActiveCount()).toBe(0);
    expect(getMaxConcurrentAgents()).toBe(DEFAULT_MAX_CONCURRENT_AGENTS);
    expect(await tryAcquire(async (slot) => slot.id)).toBe(1);
  });
});

describe('agent-pool concurrency configuration', () => {
  beforeEach(() => {
    _resetPool();
  });

  it('defaults to DEFAULT_MAX_CONCURRENT_AGENTS', () => {
    expect(getMaxConcurrentAgents()).toBe(DEFAULT_MAX_CONCURRENT_AGENTS);
  });

  it('clamps values below 1 to 1', () => {
    expect(setMaxConcurrentAgents(0)).toBe(1);
    expect(getMaxConcurrentAgents()).toBe(1);
    expect(setMaxConcurrentAgents(-5)).toBe(1);
    expect(getMaxConcurrentAgents()).toBe(1);
  });

  it('clamps values above MAX_CONCURRENT_AGENTS_LIMIT', () => {
    expect(setMaxConcurrentAgents(MAX_CONCURRENT_AGENTS_LIMIT + 1)).toBe(
      MAX_CONCURRENT_AGENTS_LIMIT,
    );
    expect(getMaxConcurrentAgents()).toBe(MAX_CONCURRENT_AGENTS_LIMIT);
    expect(setMaxConcurrentAgents(1000)).toBe(MAX_CONCURRENT_AGENTS_LIMIT);
  });

  it('accepts integer values in [1, limit]', () => {
    expect(setMaxConcurrentAgents(1)).toBe(1);
    expect(setMaxConcurrentAgents(8)).toBe(8);
    expect(setMaxConcurrentAgents(MAX_CONCURRENT_AGENTS_LIMIT)).toBe(MAX_CONCURRENT_AGENTS_LIMIT);
  });

  it('floors non-integer values', () => {
    expect(setMaxConcurrentAgents(7.9)).toBe(7);
    expect(setMaxConcurrentAgents(2.3)).toBe(2);
  });

  it('ignores non-finite values', () => {
    setMaxConcurrentAgents(8);
    expect(setMaxConcurrentAgents(Number.NaN)).toBe(8);
    expect(setMaxConcurrentAgents(Number.POSITIVE_INFINITY)).toBe(8);
    expect(getMaxConcurrentAgents()).toBe(8);
  });

  it('withSlot honors the updated cap', async () => {
    setMaxConcurrentAgents(2);
    const held = [hold(), hold()];
    expect(await tryAcquire(async () => 1)).toBe(EXHAUSTED);
    held.forEach((h) => h.release());
    await Promise.all(held.map((h) => h.released));
  });

  it('raising the cap opens new slots immediately', async () => {
    setMaxConcurrentAgents(2);
    const held = [hold(), hold()];
    expect(await tryAcquire(async () => 1)).toBe(EXHAUSTED);
    setMaxConcurrentAgents(3);
    expect(await tryAcquire(async () => 1)).toBe(1);
    held.forEach((h) => h.release());
    await Promise.all(held.map((h) => h.released));
  });
});

// The model has no other way to know what the concurrency budget is: `withSlot`
// returns `pool_exhausted` rather than queueing, so a fan-out wider than the cap
// silently loses work, and the cap is user-configurable so it cannot live in the
// (prompt-cached) system prompt.
describe('slotStatusLine', () => {
  beforeEach(() => {
    _resetPool();
    setMaxConcurrentAgents(4);
  });

  it('reports the free count and invites more work when slots remain', () => {
    expect(slotStatusLine()).toContain('4 of 4 free');
    expect(slotStatusLine()).toContain('dispatch more');
  });

  it('reports the state after the dispatch released its slot', async () => {
    let inside = '';
    await withSlot(async () => {
      inside = slotStatusLine();
      return null;
    });
    // Held during: one slot is in use.
    expect(inside).toContain('3 of 4 free');
    // Released after: the number the next decision should be made on.
    expect(slotStatusLine()).toContain('4 of 4 free');
  });

  it('tells the model to wait rather than to fan out when full', async () => {
    setMaxConcurrentAgents(1);
    await withSlot(async () => {
      expect(slotStatusLine()).toContain('0 of 1 free');
      expect(slotStatusLine()).toContain('wait');
      return null;
    });
  });

  it('tracks a cap changed mid-session', () => {
    setMaxConcurrentAgents(2);
    expect(slotStatusLine()).toContain('2 of 2 free');
  });
});
