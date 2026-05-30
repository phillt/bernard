/**
 * In-process TTL cache for pure LLM subcalls (issue #171).
 *
 * Only wired into deterministic subcalls — currently the prompt rewriter and
 * the two reference-tool-lookup stages. The main agent loop, sub-agent
 * dispatch, and tool-using calls are intentionally NOT cached.
 *
 * Kept separate from `framework/tools/result-cache.ts` because the key shape
 * (provider + model + system + messages) is unrelated to `ToolMeta` and the
 * TTL policy differs (session-scoped, finite default vs. per-tool opt-in).
 */

/** Default TTL for LLM subcall cache entries. 10 minutes. */
export const DEFAULT_LLM_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Cache key for an LLM subcall. Stringified deterministically in
 * {@link stableKey}; field ordering is significant.
 *
 * `modelId` is the AI SDK `LanguageModel.modelId` of the resolved model,
 * which differs across model-mode tiers (#170) for the same `siteName`.
 *
 * `providerOptions` is included by value so e.g. different `reasoningEffort`
 * settings hash separately. API keys are NOT part of `providerOptions` (they
 * are baked into the model instance by the SDK) and must never be included.
 */
export interface LLMCacheKey {
  /** Identifier of the subcall site, e.g. `'rewriter'`, `'reference-lookup:select'`. */
  siteName: string;
  /** AI SDK `LanguageModel.modelId`. */
  modelId: string;
  /** Provider options passed to `generateText`. */
  providerOptions?: unknown;
  /** System prompt. */
  system: string;
  /** Stringified user content (messages or single user message). */
  userContent: string;
}

interface LLMCacheEntry {
  /** The text result returned from `generateText`. */
  result: string;
  /** Expiry time in epoch ms. */
  expiresAt: number;
}

const cache = new Map<string, LLMCacheEntry>();

function stableKey(k: LLMCacheKey): string {
  return JSON.stringify({
    s: k.siteName,
    m: k.modelId,
    p: k.providerOptions ?? null,
    sys: k.system,
    u: k.userContent,
  });
}

/**
 * Returns the cached LLM result for `key`, or `undefined` on miss/expiry.
 * Expired entries are evicted on read.
 */
export function getCachedLLM(key: LLMCacheKey): string | undefined {
  const k = stableKey(key);
  const entry = cache.get(k);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(k);
    return undefined;
  }
  return entry.result;
}

/**
 * Stores `result` for `key`. Default TTL is {@link DEFAULT_LLM_CACHE_TTL_MS}.
 */
export function setCachedLLM(
  key: LLMCacheKey,
  result: string,
  ttlMs: number = DEFAULT_LLM_CACHE_TTL_MS,
): void {
  cache.set(stableKey(key), { result, expiresAt: Date.now() + ttlMs });
}

/** Clears all cached LLM entries. Exposed for tests. */
export function clearLLMCache(): void {
  cache.clear();
}
