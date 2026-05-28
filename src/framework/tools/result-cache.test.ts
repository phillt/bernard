import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getCachedResult,
  setCachedResult,
  clearCache,
  CACHE_MISS,
  DEFAULT_CACHE_TTL_MS,
} from './result-cache.js';
import type { ToolMeta } from './types.js';

const cacheableMeta: ToolMeta = {
  name: 'time_range',
  kind: 'read',
  deterministic: true,
  sideEffect: 'none',
  cacheable: true,
  cacheTtlMs: 0,
};

const nonCacheableMeta: ToolMeta = {
  name: 'web_read',
  kind: 'read',
  deterministic: false,
  sideEffect: 'network',
  cacheable: false,
};

describe('result-cache', () => {
  beforeEach(() => {
    clearCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores and retrieves a result for a cacheable tool', () => {
    setCachedResult(cacheableMeta, { start: 800, end: 1000 }, '2 hours');
    expect(getCachedResult(cacheableMeta, { start: 800, end: 1000 })).toBe('2 hours');
  });

  it('returns CACHE_MISS for a non-cacheable tool even after setCachedResult', () => {
    setCachedResult(nonCacheableMeta, { url: 'https://example.com' }, '<html/>');
    expect(getCachedResult(nonCacheableMeta, { url: 'https://example.com' })).toBe(CACHE_MISS);
  });

  it('distinguishes a cached null/undefined from a miss', () => {
    setCachedResult(cacheableMeta, { start: 0, end: 0 }, null);
    expect(getCachedResult(cacheableMeta, { start: 0, end: 0 })).toBeNull();
    setCachedResult(cacheableMeta, { start: 1, end: 1 }, undefined);
    expect(getCachedResult(cacheableMeta, { start: 1, end: 1 })).toBeUndefined();
    expect(getCachedResult(cacheableMeta, { start: 2, end: 2 })).toBe(CACHE_MISS);
  });

  it('evicts an expired entry on read', () => {
    const ttlMeta: ToolMeta = { ...cacheableMeta, cacheTtlMs: 1000 };
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(now);
    setCachedResult(ttlMeta, { x: 1 }, 'cached');
    nowSpy.mockReturnValue(now + 2000);
    expect(getCachedResult(ttlMeta, { x: 1 })).toBe(CACHE_MISS);
  });

  it('redacts sensitive args from the cache key so values do not leak', () => {
    const sensitiveMeta: ToolMeta = {
      ...cacheableMeta,
      name: 'sensitive_tool',
      sensitiveArgs: ['token'],
    };
    setCachedResult(sensitiveMeta, { token: 'alpha', x: 1 }, 'first');
    // A different `token` value with the same `x` hits the same redacted key.
    expect(getCachedResult(sensitiveMeta, { token: 'beta', x: 1 })).toBe('first');
  });

  it('does not collide an undefined-valued arg with an absent arg', () => {
    // JSON.stringify drops undefined-valued properties — `{a:undefined,b:1}`
    // and `{b:1}` would otherwise hash to the same key. The replacer must
    // distinguish them.
    setCachedResult(cacheableMeta, { a: undefined, b: 1 }, 'with-undef');
    setCachedResult(cacheableMeta, { b: 1 }, 'without');
    expect(getCachedResult(cacheableMeta, { a: undefined, b: 1 })).toBe('with-undef');
    expect(getCachedResult(cacheableMeta, { b: 1 })).toBe('without');
  });

  it('uses DEFAULT_CACHE_TTL_MS when cacheTtlMs is unset', () => {
    const meta: ToolMeta = {
      name: 'default_ttl_tool',
      kind: 'read',
      deterministic: true,
      sideEffect: 'none',
      cacheable: true,
    };
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(now);
    setCachedResult(meta, { a: 1 }, 'val');
    nowSpy.mockReturnValue(now + DEFAULT_CACHE_TTL_MS - 100);
    expect(getCachedResult(meta, { a: 1 })).toBe('val');
    nowSpy.mockReturnValue(now + DEFAULT_CACHE_TTL_MS + 100);
    expect(getCachedResult(meta, { a: 1 })).toBe(CACHE_MISS);
  });
});
