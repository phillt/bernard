import { describe, it, expect, beforeEach } from 'vitest';
import {
  withSlot,
  getActiveCount,
  getMaxConcurrentAgents,
  setMaxConcurrentAgents,
  _resetPool,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  MAX_CONCURRENT_AGENTS_LIMIT,
} from './agent-pool.js';

/** Holds a slot until `release()` is called — lets a test fill the pool. */
function hold(): { released: Promise<unknown>; release: () => void; slot: Promise<unknown> } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const released = withSlot(async (slot) => {
    await gate;
    return slot;
  });
  return { released, release, slot: released };
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
    expect(await a.released).toEqual({ acquired: true, value: { id: 1 } });
    expect(await b.released).toEqual({ acquired: true, value: { id: 2 } });
  });

  it('reports not-acquired at capacity, and never runs the body', async () => {
    const cap = getMaxConcurrentAgents();
    const held = Array.from({ length: cap }, () => hold());
    expect(getActiveCount()).toBe(cap);

    let ran = false;
    const outcome = await withSlot(async () => {
      ran = true;
      return 'x';
    });
    expect(outcome).toEqual({ acquired: false });
    expect(ran).toBe(false);

    held.forEach((h) => h.release());
    await Promise.all(held.map((h) => h.released));
  });

  it('releases on the way out, allowing re-acquisition', async () => {
    const cap = getMaxConcurrentAgents();
    const held = Array.from({ length: cap }, () => hold());
    expect((await withSlot(async () => 1)).acquired).toBe(false);

    held[0].release();
    await held[0].released;
    expect(getActiveCount()).toBe(cap - 1);
    expect((await withSlot(async () => 1)).acquired).toBe(true);

    held.slice(1).forEach((h) => h.release());
    await Promise.all(held.slice(1).map((h) => h.released));
  });

  it('releases even when the body throws', async () => {
    await expect(
      withSlot(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(getActiveCount()).toBe(0);
  });

  it('lets a nested helper through a full pool (#305)', async () => {
    // Sub-agents carry `delegate_*` tools, so a sub-agent holds a slot AND needs
    // a helper. Counting both against one flat cap starves every helper the
    // moment parallel sub-agents fill the pool — the delegate call degrades to
    // an error string and the sub-agent silently loses MCP access.
    setMaxConcurrentAgents(1);
    const outcome = await withSlot(async () => {
      // Pool is now full for ordinary dispatches...
      expect(getActiveCount()).toBe(1);
      // ...but a helper spawned from inside this slot goes through, because
      // #317 infers nesting from the ALS rather than a flag the caller passes.
      const nested = await withSlot(async (slot) => {
        // Still counted, so release stays symmetric and getActiveCount is truthful.
        expect(getActiveCount()).toBe(2);
        return slot.id;
      });
      return nested;
    });
    expect(outcome).toEqual({ acquired: true, value: { acquired: true, value: 2 } });
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

    const sibling = await withSlot(async () => 'should not run');
    expect(sibling).toEqual({ acquired: false });

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
    expect(await withSlot(async (slot) => slot.id)).toEqual({ acquired: true, value: 1 });
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
    expect((await withSlot(async () => 1)).acquired).toBe(false);
    held.forEach((h) => h.release());
    await Promise.all(held.map((h) => h.released));
  });

  it('raising the cap opens new slots immediately', async () => {
    setMaxConcurrentAgents(2);
    const held = [hold(), hold()];
    expect((await withSlot(async () => 1)).acquired).toBe(false);
    setMaxConcurrentAgents(3);
    expect((await withSlot(async () => 1)).acquired).toBe(true);
    held.forEach((h) => h.release());
    await Promise.all(held.map((h) => h.released));
  });
});
