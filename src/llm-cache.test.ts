import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getCachedLLM,
  setCachedLLM,
  clearLLMCache,
  DEFAULT_LLM_CACHE_TTL_MS,
  type LLMCacheKey,
} from './llm-cache.js';

const baseKey: LLMCacheKey = {
  siteName: 'rewriter',
  modelId: 'claude-haiku-4-5-20251001',
  providerOptions: { anthropic: { reasoningEffort: 'low' } },
  system: 'You are a prompt preprocessor.',
  userContent: '## Original user input\nhello world',
};

describe('llm-cache (#171)', () => {
  beforeEach(() => {
    clearLLMCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined on cold get', () => {
    expect(getCachedLLM(baseKey)).toBeUndefined();
  });

  it('round-trips a value through set/get', () => {
    setCachedLLM(baseKey, '{"status":"noop"}');
    expect(getCachedLLM(baseKey)).toBe('{"status":"noop"}');
  });

  it('expires entries past the TTL', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    setCachedLLM(baseKey, 'cached');
    expect(getCachedLLM(baseKey)).toBe('cached');
    vi.spyOn(Date, 'now').mockReturnValue(now + DEFAULT_LLM_CACHE_TTL_MS + 1);
    expect(getCachedLLM(baseKey)).toBeUndefined();
  });

  it('honors a custom ttlMs override', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    setCachedLLM(baseKey, 'short', 1000);
    vi.spyOn(Date, 'now').mockReturnValue(now + 1500);
    expect(getCachedLLM(baseKey)).toBeUndefined();
  });

  it('different modelId hashes to a different key', () => {
    setCachedLLM(baseKey, 'haiku-result');
    const otherModel: LLMCacheKey = { ...baseKey, modelId: 'claude-opus-4-6' };
    expect(getCachedLLM(otherModel)).toBeUndefined();
    setCachedLLM(otherModel, 'opus-result');
    expect(getCachedLLM(baseKey)).toBe('haiku-result');
    expect(getCachedLLM(otherModel)).toBe('opus-result');
  });

  it('different siteName hashes to a different key', () => {
    setCachedLLM(baseKey, 'rewriter-result');
    const otherSite: LLMCacheKey = { ...baseKey, siteName: 'reference-lookup:select' };
    expect(getCachedLLM(otherSite)).toBeUndefined();
  });

  it('different system prompt hashes to a different key', () => {
    setCachedLLM(baseKey, 'one');
    const otherSystem: LLMCacheKey = { ...baseKey, system: baseKey.system + ' (v2)' };
    expect(getCachedLLM(otherSystem)).toBeUndefined();
  });

  it('different userContent hashes to a different key', () => {
    setCachedLLM(baseKey, 'one');
    const otherUser: LLMCacheKey = { ...baseKey, userContent: 'something else' };
    expect(getCachedLLM(otherUser)).toBeUndefined();
  });

  it('clearLLMCache empties the cache', () => {
    setCachedLLM(baseKey, 'x');
    clearLLMCache();
    expect(getCachedLLM(baseKey)).toBeUndefined();
  });

  it('treats absent and null providerOptions as the same key', () => {
    // Both serialize as JSON null in the stable key — intentional.
    setCachedLLM({ ...baseKey, providerOptions: undefined }, 'undef');
    expect(getCachedLLM({ ...baseKey, providerOptions: null })).toBe('undef');
  });
});
