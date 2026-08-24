import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireSlot,
  releaseSlot,
  getActiveCount,
  getMaxConcurrentAgents,
  setMaxConcurrentAgents,
  _resetPool,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  MAX_CONCURRENT_AGENTS_LIMIT,
} from './agent-pool.js';

describe('agent-pool', () => {
  beforeEach(() => {
    _resetPool();
  });

  it('acquires slots with incrementing IDs', () => {
    const a = acquireSlot();
    const b = acquireSlot();
    expect(a).toEqual({ id: 1 });
    expect(b).toEqual({ id: 2 });
    expect(getActiveCount()).toBe(2);
  });

  it('returns null when at capacity', () => {
    const cap = getMaxConcurrentAgents();
    for (let i = 0; i < cap; i++) {
      expect(acquireSlot()).not.toBeNull();
    }
    expect(acquireSlot()).toBeNull();
    expect(getActiveCount()).toBe(cap);
  });

  it('releases slots and allows re-acquisition', () => {
    const cap = getMaxConcurrentAgents();
    for (let i = 0; i < cap; i++) {
      acquireSlot();
    }
    expect(acquireSlot()).toBeNull();
    releaseSlot();
    expect(getActiveCount()).toBe(cap - 1);
    expect(acquireSlot()).not.toBeNull();
  });

  it('does not go below zero on extra release', () => {
    releaseSlot();
    expect(getActiveCount()).toBe(0);
  });

  it('lets a nested helper through a full pool (#305)', () => {
    // Sub-agents carry `delegate_*` tools, so a sub-agent holds a slot AND needs
    // a helper. Counting both against one flat cap starves every helper the
    // moment parallel sub-agents fill the pool — the delegate call degrades to
    // an error string and the sub-agent silently loses MCP access.
    setMaxConcurrentAgents(2);
    expect(acquireSlot()).not.toBeNull();
    expect(acquireSlot()).not.toBeNull();
    expect(acquireSlot()).toBeNull(); // pool full for ordinary dispatches

    const helper = acquireSlot({ nested: true });
    expect(helper).not.toBeNull();
    // Still counted, so release stays symmetric and getActiveCount is truthful.
    expect(getActiveCount()).toBe(3);
    releaseSlot();
    expect(getActiveCount()).toBe(2);
  });

  it('still hands nested helpers distinct ids', () => {
    setMaxConcurrentAgents(1);
    const a = acquireSlot();
    const b = acquireSlot({ nested: true });
    const c = acquireSlot({ nested: true });
    expect(new Set([a?.id, b?.id, c?.id]).size).toBe(3);
  });

  it('resets state completely', () => {
    acquireSlot();
    acquireSlot();
    _resetPool();
    expect(getActiveCount()).toBe(0);
    expect(getMaxConcurrentAgents()).toBe(DEFAULT_MAX_CONCURRENT_AGENTS);
    const slot = acquireSlot();
    expect(slot).toEqual({ id: 1 });
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

  it('acquireSlot honors the updated cap', () => {
    setMaxConcurrentAgents(2);
    expect(acquireSlot()).not.toBeNull();
    expect(acquireSlot()).not.toBeNull();
    expect(acquireSlot()).toBeNull();
  });

  it('raising the cap opens new slots immediately', () => {
    setMaxConcurrentAgents(2);
    acquireSlot();
    acquireSlot();
    expect(acquireSlot()).toBeNull();
    setMaxConcurrentAgents(3);
    expect(acquireSlot()).not.toBeNull();
  });
});
