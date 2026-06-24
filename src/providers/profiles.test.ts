import { describe, it, expect } from 'vitest';
import { getModelProfile, modelSupportsTemperature } from './profiles.js';

describe('getModelProfile — resolution', () => {
  it('returns anthropic-claude for any anthropic model', () => {
    expect(getModelProfile('anthropic', 'claude-sonnet-4-5-20250929').family).toBe(
      'anthropic-claude',
    );
    expect(getModelProfile('anthropic', 'claude-opus-4-6').family).toBe('anthropic-claude');
    expect(getModelProfile('anthropic', 'claude-haiku-4-5-20251001').family).toBe(
      'anthropic-claude',
    );
    expect(getModelProfile('anthropic', 'some-future-model').family).toBe('anthropic-claude');
  });

  it('routes OpenAI o-series models to openai-reasoning', () => {
    expect(getModelProfile('openai', 'o1').family).toBe('openai-reasoning');
    expect(getModelProfile('openai', 'o3').family).toBe('openai-reasoning');
    expect(getModelProfile('openai', 'o3-mini').family).toBe('openai-reasoning');
    expect(getModelProfile('openai', 'o4-mini').family).toBe('openai-reasoning');
  });

  it('routes non-o-series OpenAI models to openai-standard', () => {
    expect(getModelProfile('openai', 'gpt-4o').family).toBe('openai-standard');
    expect(getModelProfile('openai', 'gpt-4o-mini').family).toBe('openai-standard');
    expect(getModelProfile('openai', 'gpt-4.1').family).toBe('openai-standard');
    expect(getModelProfile('openai', 'gpt-4.1-nano').family).toBe('openai-standard');
    // gpt-5.2-chat-latest isn't in the catalog → pattern fallback → standard.
    expect(getModelProfile('openai', 'gpt-5.2-chat-latest').family).toBe('openai-standard');
  });

  it('catalog-tagged reasoning models override the pattern matcher', () => {
    // gpt-5.2 carries a `reasoning` tag in the vendored catalog snapshot, so
    // the catalog-first lookup routes it to openai-reasoning even though the
    // pattern matcher alone would say standard.
    expect(getModelProfile('openai', 'gpt-5.2').family).toBe('openai-reasoning');
  });

  it('routes xai grok-4 reasoning variants to xai-grok-reasoning', () => {
    expect(getModelProfile('xai', 'grok-4-fast-reasoning').family).toBe('xai-grok-reasoning');
    expect(getModelProfile('xai', 'grok-4-1-fast-reasoning').family).toBe('xai-grok-reasoning');
    expect(getModelProfile('xai', 'grok-4-0709').family).toBe('xai-grok-reasoning');
  });

  it('routes xai explicit non-reasoning variants to xai-grok-standard', () => {
    expect(getModelProfile('xai', 'grok-4-fast-non-reasoning').family).toBe('xai-grok-standard');
    expect(getModelProfile('xai', 'grok-4-1-fast-non-reasoning').family).toBe('xai-grok-standard');
  });

  it('routes older xai grok-3 and grok-code to xai-grok-standard', () => {
    expect(getModelProfile('xai', 'grok-3').family).toBe('xai-grok-standard');
    expect(getModelProfile('xai', 'grok-3-mini').family).toBe('xai-grok-standard');
    expect(getModelProfile('xai', 'grok-code-fast-1').family).toBe('xai-grok-standard');
  });

  it('falls back to default for unknown providers', () => {
    expect(getModelProfile('cohere', 'command-r').family).toBe('default');
    expect(getModelProfile('', '').family).toBe('default');
  });

  it('is case-insensitive on model names', () => {
    expect(getModelProfile('openai', 'O3').family).toBe('openai-reasoning');
    expect(getModelProfile('xai', 'Grok-4-Fast-Reasoning').family).toBe('xai-grok-reasoning');
  });
});

describe('wrapUserMessage — per family', () => {
  it('wraps Claude messages in <user_request>', () => {
    const out = getModelProfile('anthropic', 'claude-opus-4-6').wrapUserMessage('list files');
    expect(out).toBe('<user_request>\nlist files\n</user_request>');
  });

  it('wraps OpenAI standard messages with a markdown heading', () => {
    const out = getModelProfile('openai', 'gpt-4.1').wrapUserMessage('list files');
    expect(out).toBe('# Request\nlist files');
  });

  it('passes reasoning-model messages through unchanged', () => {
    expect(getModelProfile('openai', 'o3').wrapUserMessage('list files')).toBe('list files');
    expect(getModelProfile('xai', 'grok-4-fast-reasoning').wrapUserMessage('list files')).toBe(
      'list files',
    );
  });

  it('is lossless — original message appears verbatim in the wrap', () => {
    const tricky = 'Fix this: x < y && y > 0\n\nAlso: please keep changes minimal.';
    for (const [provider, model] of [
      ['anthropic', 'claude-opus-4-6'],
      ['openai', 'gpt-5.2'],
      ['openai', 'o3'],
      ['xai', 'grok-4-fast-reasoning'],
      ['xai', 'grok-3'],
    ] as const) {
      const out = getModelProfile(provider, model).wrapUserMessage(tricky);
      expect(out).toContain(tricky);
    }
  });
});

describe('systemSuffix — per family', () => {
  it('includes XML-wrapping note for Claude', () => {
    expect(getModelProfile('anthropic', 'claude-opus-4-6').systemSuffix).toContain(
      '<user_request>',
    );
  });

  it('includes Formatting re-enabled for OpenAI reasoning models', () => {
    expect(getModelProfile('openai', 'o3').systemSuffix).toMatch(/^Formatting re-enabled/);
  });

  it('includes agentic persistence guidance for OpenAI standard models', () => {
    expect(getModelProfile('openai', 'gpt-4.1').systemSuffix).toMatch(/Persistence/i);
  });

  it('strips CoT language for all reasoning families', () => {
    expect(getModelProfile('openai', 'o3').systemSuffix).toMatch(/chain-of-thought/i);
    expect(getModelProfile('xai', 'grok-4-fast-reasoning').systemSuffix).toMatch(
      /chain-of-thought/i,
    );
  });

  it('leaves non-reasoning xai standard models with no suffix', () => {
    expect(getModelProfile('xai', 'grok-3').systemSuffix).toBe('');
  });

  it('default profile has no suffix and passthrough wrap', () => {
    const p = getModelProfile('unknown', 'mystery-model');
    expect(p.systemSuffix).toBe('');
    expect(p.wrapUserMessage('hi')).toBe('hi');
  });
});

describe('rewriterHint — per family', () => {
  it('every family has a non-empty rewriterHint', () => {
    for (const [provider, model] of [
      ['anthropic', 'claude-opus-4-6'],
      ['openai', 'o3'],
      ['openai', 'gpt-4.1'],
      ['xai', 'grok-4-fast-reasoning'],
      ['xai', 'grok-3'],
      ['unknown', 'mystery-model'],
    ] as const) {
      const hint = getModelProfile(provider, model).rewriterHint;
      expect(hint.length).toBeGreaterThan(0);
    }
  });

  it('reasoning-family hints emphasize terseness', () => {
    expect(getModelProfile('openai', 'o3').rewriterHint).toMatch(/terse/i);
    expect(getModelProfile('xai', 'grok-4-fast-reasoning').rewriterHint).toMatch(/terse|direct/i);
  });
});

describe('modelSupportsTemperature', () => {
  it('returns false for claude-opus-4-8 (catalog-tagged reasoning, rejects temperature)', () => {
    // claude-opus-4-8 is in the vendored catalog with the `reasoning` tag and
    // rejects temperature with a 400 (it always operates in reasoning mode).
    expect(modelSupportsTemperature('claude-opus-4-8', 'anthropic')).toBe(false);
    // Without provider, catalog-first lookup still fires and returns false.
    expect(modelSupportsTemperature('claude-opus-4-8')).toBe(false);
  });

  it('returns false for other catalog-tagged Anthropic reasoning models', () => {
    expect(modelSupportsTemperature('claude-opus-4-6', 'anthropic')).toBe(false);
    expect(modelSupportsTemperature('claude-sonnet-4-6', 'anthropic')).toBe(false);
  });

  it('returns false for OpenAI o-series reasoning models (pattern fallback)', () => {
    // provider must be explicitly 'openai' for the pattern to fire (avoids
    // false positives for custom providers with o-series–like model names).
    expect(modelSupportsTemperature('o3', 'openai')).toBe(false);
    expect(modelSupportsTemperature('o1', 'openai')).toBe(false);
    expect(modelSupportsTemperature('o4-mini', 'openai')).toBe(false);
    expect(modelSupportsTemperature('o3-mini', 'openai')).toBe(false);
  });

  it('returns false for catalog-tagged OpenAI reasoning models', () => {
    // gpt-5.2 carries the `reasoning` tag in the vendored catalog.
    expect(modelSupportsTemperature('gpt-5.2', 'openai')).toBe(false);
  });

  it('returns false for xAI reasoning variants (pattern fallback)', () => {
    // provider must be explicitly 'xai' for the grok-4 pattern to fire.
    expect(modelSupportsTemperature('grok-4-fast-reasoning', 'xai')).toBe(false);
    expect(modelSupportsTemperature('grok-4-0709', 'xai')).toBe(false);
  });

  it('returns true for non-reasoning OpenAI models', () => {
    // gpt-4.1 is not tagged reasoning in the catalog.
    expect(modelSupportsTemperature('gpt-4.1', 'openai')).toBe(true);
    expect(modelSupportsTemperature('gpt-4.1-mini', 'openai')).toBe(true);
  });

  it('returns true for xAI explicit non-reasoning variants', () => {
    expect(modelSupportsTemperature('grok-4-fast-non-reasoning', 'xai')).toBe(true);
  });

  it('returns true for unknown / custom-provider models (fail-open)', () => {
    // Unknown models should fail open so callers send temperature for them.
    expect(modelSupportsTemperature('some-unknown-model')).toBe(true);
    expect(modelSupportsTemperature('my-fine-tuned-model', 'custom-provider')).toBe(true);
  });

  it('returns true for versioned Anthropic model IDs not in catalog (fail-open)', () => {
    // The vendored catalog has claude-haiku-4-5 (without date suffix) but not
    // claude-haiku-4-5-20251001 — versioned IDs miss the catalog and fail open.
    expect(modelSupportsTemperature('claude-haiku-4-5-20251001', 'anthropic')).toBe(true);
  });

  it('does not apply provider-specific patterns without an explicit provider (fail-open for catalog-unknown models)', () => {
    // Provider-specific patterns (o-series, grok-4) only fire when provider is
    // explicit. Models not in the catalog and without a provider fail open.
    // 'o1-uncensored' has a longer id — not in catalog — and no provider, so fails open.
    expect(modelSupportsTemperature('o1-uncensored')).toBe(true);
    // 'grok-4-fast-turbo' is not in catalog and no provider → fail open.
    expect(modelSupportsTemperature('grok-4-fast-turbo')).toBe(true);
    // Note: 'o3' alone IS in the catalog tagged reasoning so returns false even without provider.
  });
});
