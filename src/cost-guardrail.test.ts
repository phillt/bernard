import { describe, it, expect } from 'vitest';
import { noPromptCacheHint } from './cost-guardrail.js';
import { providerSupportsPromptCache } from './providers/prompt-cache.js';

describe('providerSupportsPromptCache', () => {
  it('is true for caching providers', () => {
    expect(providerSupportsPromptCache('anthropic')).toBe(true);
    expect(providerSupportsPromptCache('openai')).toBe(true);
  });

  it('is false for xAI and custom/unknown providers', () => {
    expect(providerSupportsPromptCache('xai')).toBe(false);
    expect(providerSupportsPromptCache('ollama')).toBe(false);
    expect(providerSupportsPromptCache('my-proxy')).toBe(false);
  });
});

describe('noPromptCacheHint', () => {
  const base = {
    provider: 'xai',
    promptTokens: 90_000,
    thresholdTokens: 60_000,
    alreadyWarned: false,
  };

  it('fires on a non-caching provider with a large prefix', () => {
    const hint = noPromptCacheHint(base);
    expect(hint).toBeTruthy();
    expect(hint).toContain('xai');
    expect(hint).toContain('prompt-cache');
  });

  it('stays silent on a caching provider even with a huge prefix', () => {
    expect(noPromptCacheHint({ ...base, provider: 'anthropic' })).toBeNull();
    expect(noPromptCacheHint({ ...base, provider: 'openai' })).toBeNull();
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
