// TODO(#171): wire `getCachedResult` / `setCachedResult` into `augmentTools`
// so deterministic, side-effect-free tools transparently hit the cache. Until
// then the cache is exposed for future use and exercised by unit tests only.

import { isCacheable, type ToolMeta } from './types.js';
import { redactArgs } from './redact.js';

/** Default TTL when a tool's `cacheTtlMs` is unset. 5 minutes. */
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  result: unknown;
  /** Expiry time in epoch ms. `0` means never expires. */
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(meta: ToolMeta, args: unknown): string {
  const safeArgs = redactArgs(args, meta.sensitiveArgs);
  return `${meta.name}::${JSON.stringify(safeArgs)}`;
}

/**
 * Returns the cached result for `(meta, args)` or `null` when the tool is not
 * cacheable, there is no entry, or the entry has expired. Expired entries are
 * evicted on read.
 */
export function getCachedResult(meta: ToolMeta, args: unknown): unknown | null {
  if (!isCacheable(meta)) return null;
  const key = cacheKey(meta, args);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== 0 && Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
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
