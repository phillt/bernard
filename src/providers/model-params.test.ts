import { describe, it, expect } from 'vitest';
import { describeModelParams, serializeModelParams, validateModelParams } from './model-params.js';

// These tests use model names absent from the vendored catalog so the adapter's
// family heuristics (the catalog-miss fallback) fire deterministically, rather
// than depending on catalog tag contents that can shift.

describe('describeModelParams — capability gating', () => {
  it('xAI reasoning model exposes reasoningEffort [low, high] and no temperature', () => {
    const ds = describeModelParams('xai', 'grok-4-fast-reasoning');
    const byId = Object.fromEntries(ds.map((d) => [d.id, d]));
    expect(byId.reasoningEffort).toBeDefined();
    expect(byId.reasoningEffort.kind).toBe('enum');
    expect(byId.reasoningEffort.options).toEqual(['low', 'high']);
    expect(byId.temperature).toBeUndefined();
    expect(byId.topP).toBeUndefined();
    // max output tokens is universal
    expect(byId.maxOutputTokens).toBeDefined();
  });

  it('OpenAI reasoning model exposes reasoningEffort [minimal, low, medium, high]', () => {
    const ds = describeModelParams('openai', 'o3-pro-test');
    const byId = Object.fromEntries(ds.map((d) => [d.id, d]));
    expect(byId.reasoningEffort?.options).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(byId.temperature).toBeUndefined();
  });

  it('non-reasoning model exposes temperature and topP', () => {
    const ds = describeModelParams('openai', 'gpt-4-omni-test');
    const byId = Object.fromEntries(ds.map((d) => [d.id, d]));
    expect(byId.temperature).toBeDefined();
    expect(byId.temperature.kind).toBe('range');
    expect(byId.topP).toBeDefined();
    expect(byId.reasoningEffort).toBeUndefined();
  });

  it('Anthropic model exposes a thinkingBudget number param', () => {
    const ds = describeModelParams('anthropic', 'claude-test-1');
    const byId = Object.fromEntries(ds.map((d) => [d.id, d]));
    expect(byId.thinkingBudget).toBeDefined();
    expect(byId.thinkingBudget.kind).toBe('number');
  });

  it('never exposes both temperature and reasoningEffort for a catalog-miss gpt-5 reasoning model', () => {
    // `gpt-5-experimental-test` isn't in the catalog; the family heuristic
    // classifies it as reasoning, but `modelSupportsTemperature` (o-series only)
    // would otherwise fail open. The `!reasoning` gate must win so we don't offer
    // a temperature knob alongside reasoningEffort (the API would 400 on both).
    const ds = describeModelParams('openai', 'gpt-5-experimental-test');
    const byId = Object.fromEntries(ds.map((d) => [d.id, d]));
    expect(byId.reasoningEffort).toBeDefined();
    expect(byId.temperature).toBeUndefined();
    expect(byId.topP).toBeUndefined();
  });

  it('keys the param surface off the wrapped sdk for custom providers', () => {
    // An Ollama-style provider wrapping the OpenAI SDK with a reasoning model.
    const ds = describeModelParams('ollama', 'o3-local-test', 'openai');
    const byId = Object.fromEntries(ds.map((d) => [d.id, d]));
    expect(byId.reasoningEffort?.options).toEqual(['minimal', 'low', 'medium', 'high']);
  });
});

describe('serializeModelParams — routing to the two destinations', () => {
  it('routes temperature/topP to top-level params and maxOutputTokens to the SDK maxTokens key', () => {
    const { params, providerOptions } = serializeModelParams('openai', 'gpt-4-omni-test', {
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 1024,
    });
    // AI SDK v4 names the cap `maxTokens`.
    expect(params).toEqual({ temperature: 0.7, topP: 0.9, maxTokens: 1024 });
    expect(providerOptions).toEqual({});
  });

  it('routes xAI reasoningEffort to providerOptions.xai', () => {
    const { params, providerOptions } = serializeModelParams('xai', 'grok-4-fast-reasoning', {
      reasoningEffort: 'high',
    });
    expect(params).toEqual({});
    expect(providerOptions).toEqual({ xai: { reasoningEffort: 'high' } });
  });

  it('routes OpenAI reasoningEffort to providerOptions.openai', () => {
    const { providerOptions } = serializeModelParams('openai', 'o3-pro-test', {
      reasoningEffort: 'medium',
    });
    expect(providerOptions).toEqual({ openai: { reasoningEffort: 'medium' } });
  });

  it('routes Anthropic thinkingBudget to providerOptions.anthropic.thinking', () => {
    const { providerOptions } = serializeModelParams('anthropic', 'claude-test-1', {
      thinkingBudget: 4096,
    });
    expect(providerOptions).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } },
    });
  });

  it('omits Anthropic thinking when budget is 0 (disabled)', () => {
    const { providerOptions } = serializeModelParams('anthropic', 'claude-test-1', {
      thinkingBudget: 0,
    });
    expect(providerOptions).toEqual({});
  });

  it('returns empty objects for undefined values', () => {
    const { params, providerOptions } = serializeModelParams(
      'openai',
      'gpt-4-omni-test',
      undefined,
    );
    expect(params).toEqual({});
    expect(providerOptions).toEqual({});
  });
});

describe('validateModelParams — capability gate', () => {
  it('drops temperature on a reasoning model', () => {
    const out = validateModelParams('xai', 'grok-4-fast-reasoning', {
      temperature: 0.5,
      reasoningEffort: 'high',
    });
    expect(out).toEqual({ reasoningEffort: 'high' });
  });

  it('drops reasoningEffort on a non-reasoning model', () => {
    const out = validateModelParams('openai', 'gpt-4-omni-test', {
      reasoningEffort: 'high',
      temperature: 0.3,
    });
    expect(out).toEqual({ temperature: 0.3 });
  });

  it('serialize never emits a rejected param even if smuggled in', () => {
    const { params } = serializeModelParams('xai', 'grok-4-fast-reasoning', {
      temperature: 0.5,
    });
    expect(params.temperature).toBeUndefined();
  });
});
