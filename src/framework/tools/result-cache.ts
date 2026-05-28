// TODO(#171): wire `getCachedResult` / `setCachedResult` into `augmentTools`
// so deterministic, side-effect-free tools transparently hit the cache. Until
// then the cache is exposed for future use and exercised by unit tests only.

import { isCacheable, type ToolMeta } from './types.js';
import { redactArgs } from './redact.js';

/** Default TTL when a tool's `cacheTtlMs` is unset. 5 minutes. */
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Sentinel returned by {@link getCachedResult} to signal "no cached value"
 * (non-cacheable tool, no entry, or expired entry). A unique symbol so it
 * cannot collide with a legitimate cached value — including `null` or
 * `undefined`, both of which are valid cached results.
 */
export const CACHE_MISS: unique symbol = Symbol('bernard.cache.miss');
export type CacheMiss = typeof CACHE_MISS;

interface CacheEntry {
  result: unknown;
  /** Expiry time in epoch ms. `0` means never expires. */
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * `JSON.stringify` silently omits object properties whose value is `undefined`,
 * so `{a: undefined, b: 1}` and `{b: 1}` collide on the cache key even though
 * Zod's `.optional()` preserves the distinction at the object level. Replace
 * `undefined` with an explicit sentinel so the two shapes hash distinctly.
 */
const UNDEF_SENTINEL = '__bernard.cache.undef__';
function stringifyArgs(args: unknown): string {
  return JSON.stringify(args, (_k, v) => (v === undefined ? UNDEF_SENTINEL : v));
}

function cacheKey(meta: ToolMeta, args: unknown): string {
  const safeArgs = redactArgs(args, meta.sensitiveArgs);
  return `${meta.name}::${stringifyArgs(safeArgs)}`;
}

/**
 * Returns the cached result for `(meta, args)` or {@link CACHE_MISS} when the
 * tool is not cacheable, there is no entry, or the entry has expired. Expired
 * entries are evicted on read. Callers must check `=== CACHE_MISS` rather than
 * comparing to `null`/`undefined`, since both are valid cached values.
 */
export function getCachedResult(meta: ToolMeta, args: unknown): unknown | CacheMiss {
  if (!isCacheable(meta)) return CACHE_MISS;
  const key = cacheKey(meta, args);
  const entry = cache.get(key);
  if (!entry) return CACHE_MISS;
  if (entry.expiresAt !== 0 && Date.now() > entry.expiresAt) {
    cache.delete(key);
    return CACHE_MISS;
  }
  return entry.result;
}

/**
 * Stores `result` for `(meta, args)`. No-op for non-cacheable tools.
 * Honors `meta.cacheTtlMs` (default {@link DEFAULT_CACHE_TTL_MS}; `0` means
 * indefinite).
 */
export function setCachedResult(meta: ToolMeta, args: unknown, result: unknown): void {
  if (!isCacheable(meta)) return;
  const ttl = meta.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const expiresAt = ttl === 0 ? 0 : Date.now() + ttl;
  cache.set(cacheKey(meta, args), { result, expiresAt });
}

/** Clears all cached entries. Exposed for tests. */
export function clearCache(): void {
  cache.clear();
}
