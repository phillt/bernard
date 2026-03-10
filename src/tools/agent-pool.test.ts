import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireSlot,
  releaseSlot,
  getActiveCount,
  _resetPool,
  MAX_CONCURRENT_AGENTS,
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
    for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) {
      expect(acquireSlot()).not.toBeNull();
    }
    expect(acquireSlot()).toBeNull();
    expect(getActiveCount()).toBe(MAX_CONCURRENT_AGENTS);
  });

  it('releases slots and allows re-acquisition', () => {
    for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) {
      acquireSlot();
    }
    expect(acquireSlot()).toBeNull();
    releaseSlot();
    expect(getActiveCount()).toBe(MAX_CONCURRENT_AGENTS - 1);
    expect(acquireSlot()).not.toBeNull();
  });

  it('does not go below zero on extra release', () => {
    releaseSlot();
    expect(getActiveCount()).toBe(0);
  });

  it('resets state completely', () => {
    acquireSlot();
    acquireSlot();
    _resetPool();
    expect(getActiveCount()).toBe(0);
    const slot = acquireSlot();
    expect(slot).toEqual({ id: 1 });
  });
});
