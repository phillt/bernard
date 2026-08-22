import { describe, it, expect } from 'vitest';
import { noPromptCacheHint } from './cost-guardrail.js';
import { providerSupportsPromptCache } from './providers/prompt-cache.js';

describe('providerSupportsPromptCache', () => {
  it('is true for every built-in provider', () => {
    expect(providerSupportsPromptCache('anthropic')).toBe(true);
    expect(providerSupportsPromptCache('openai')).toBe(true);
    // xAI does cache implicitly — measured at ~80% hit against its own usage
    // export, and every xai catalog entry publishes a cache-read rate.
    expect(providerSupportsPromptCache('xai')).toBe(true);
  });

  it('is false for custom/unknown providers, which offer no such guarantee', () => {
    expect(providerSupportsPromptCache('ollama')).toBe(false);
    expect(providerSupportsPromptCache('my-proxy')).toBe(false);
  });
});

describe('noPromptCacheHint', () => {
  const base = {
    // A custom endpoint: no prompt-cache guarantee, so the hint is meaningful.
    provider: 'my-proxy',
    promptTokens: 90_000,
    thresholdTokens: 60_000,
    alreadyWarned: false,
  };

  it('fires on a non-caching provider with a large prefix', () => {
    const hint = noPromptCacheHint(base);
    expect(hint).toBeTruthy();
    expect(hint).toContain('my-proxy');
    expect(hint).toContain('prompt-cache');
  });

  it('stays silent on a caching provider even with a huge prefix', () => {
    expect(noPromptCacheHint({ ...base, provider: 'anthropic' })).toBeNull();
    expect(noPromptCacheHint({ ...base, provider: 'openai' })).toBeNull();
    // Regression guard: this fired on xAI while ~80% of the prefix was in fact
    // being served from cache, telling users to switch to a caching provider
    // they were already on.
    expect(noPromptCacheHint({ ...base, provider: 'xai' })).toBeNull();
  });

  it('stays silent below the threshold', () => {
    expect(noPromptCacheHint({ ...base, promptTokens: 10_000 })).toBeNull();
  });

  it('stays silent once already warned (rate-limited to once per session)', () => {
    expect(noPromptCacheHint({ ...base, alreadyWarned: true })).toBeNull();
  });

  it('is disabled when the threshold is 0', () => {
    expect(noPromptCacheHint({ ...base, thresholdTokens: 0 })).toBeNull();
  });
});
