import { describe, it, expect, vi } from 'vitest';
import { getModel, getProviderOptions } from './index.js';

// The module builds its own clients rather than using each SDK's exported
// default instance, because only the factory form accepts a custom `fetch`
// (#302). So the factories are what these tests mock.
// `vi.hoisted` because `vi.mock` factories are lifted above module-level
// consts, and these clients are constructed at import time.
const factories = vi.hoisted(() => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ modelId: 'anthropic-mock' }))),
  createOpenAI: vi.fn(() => ({ responses: vi.fn(() => ({ modelId: 'openai-mock' })) })),
  createXai: vi.fn(() => vi.fn(() => ({ modelId: 'xai-mock' }))),
}));

vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: factories.createAnthropic }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: factories.createOpenAI }));
vi.mock('@ai-sdk/xai', () => ({ createXai: factories.createXai }));

describe('getModel', () => {
  it('dispatches to anthropic SDK', () => {
    const model = getModel('anthropic', 'claude-sonnet-4-5-20250929');
    expect(model).toEqual({ modelId: 'anthropic-mock' });
  });

  it('dispatches to openai SDK', () => {
    const model = getModel('openai', 'gpt-4o-mini');
    expect(model).toEqual({ modelId: 'openai-mock' });
  });

  it('dispatches to xai SDK', () => {
    const model = getModel('xai', 'grok-3');
    expect(model).toEqual({ modelId: 'xai-mock' });
  });

  it('gives every built-in client the stall guard (#302)', () => {
    // A provider that accepts the POST and never answers is the failure mode;
    // the guard only exists if it actually reaches the client.
    for (const factory of [
      factories.createAnthropic,
      factories.createOpenAI,
      factories.createXai,
    ]) {
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({ fetch: expect.any(Function) }),
      );
    }
  });

  it("preserves openai's `compatibility: 'strict'`", () => {
    // The SDK's own default `openai` export passes this; constructing the
    // client ourselves must not silently drop it.
    expect(factories.createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ compatibility: 'strict' }),
    );
  });

  it('throws for unknown provider', () => {
    expect(() => getModel('unknown', 'model')).toThrow(/Unknown provider/);
  });
});

describe('getProviderOptions', () => {
  it('returns strictSchemas:false for openai', () => {
    expect(getProviderOptions('openai')).toEqual({ openai: { strictSchemas: false } });
  });

  it('returns undefined for anthropic', () => {
    expect(getProviderOptions('anthropic')).toBeUndefined();
  });

  it('returns undefined for xai', () => {
    expect(getProviderOptions('xai')).toBeUndefined();
  });
});
