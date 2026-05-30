import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BernardConfig } from './config.js';
import type { Specialist } from './specialists.js';
import { resolveSiteModel, _resetModelPolicyLogCacheForTests, type ModelMode } from './model-policy.js';

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((m: string) => ({ modelId: `anthropic:${m}` })),
  createAnthropic: vi.fn(() => (m: string) => ({ modelId: `anthropic:${m}` })),
}));
vi.mock('@ai-sdk/openai', () => ({
  openai: { responses: vi.fn((m: string) => ({ modelId: `openai:${m}` })) },
  createOpenAI: vi.fn(() => ({ responses: (m: string) => ({ modelId: `openai:${m}` }) })),
}));
vi.mock('@ai-sdk/xai', () => ({
  xai: vi.fn((m: string) => ({ modelId: `xai:${m}` })),
  createXai: vi.fn(() => (m: string) => ({ modelId: `xai:${m}` })),
}));

function makeConfig(overrides?: Partial<BernardConfig>): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    ragEnabled: true,
    theme: 'bernard',
    maxSteps: 25,
    coordinatorMode: 'auto',
    modelMode: 'off',
    subagentPac: true,
    toolDetails: false,
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    correctionEnabled: true,
    promptRewriter: true,
    referenceLookup: true,
    referenceLookupTools: [],
    scratchSubjectThreshold: 0.15,
    anthropicApiKey: 'sk-ant',
    openaiApiKey: 'sk-openai',
    xaiApiKey: 'xai-key',
    apiKeys: { anthropic: 'sk-ant', openai: 'sk-openai', xai: 'xai-key' },
    customProviders: {},
    ...overrides,
  };
}

beforeEach(() => {
  _resetModelPolicyLogCacheForTests();
});

describe('resolveSiteModel — mode off (passthrough)', () => {
  it('returns config.provider/model for every site', () => {
    const config = makeConfig({ modelMode: 'off' });
    for (const site of [
      'main',
      'specialist',
      'rewriter',
      'tool-wrapper',
      'reference-resolver',
    ] as const) {
      const r = resolveSiteModel(config, site);
      expect(r.provider).toBe('anthropic');
      expect(r.modelName).toBe('claude-sonnet-4-5-20250929');
      expect(r.source).toBe('config');
      expect(r.tier).toBeUndefined();
    }
  });
});

describe('resolveSiteModel — tier mapping per mode (anthropic)', () => {
  it('optimize-tokens uses mid for main, cheap for rewriter', () => {
    const config = makeConfig({ modelMode: 'optimize-tokens' });
    expect(resolveSiteModel(config, 'main').modelName).toBe('claude-sonnet-4-5-20250929');
    expect(resolveSiteModel(config, 'rewriter').modelName).toBe('claude-haiku-4-5-20251001');
    expect(resolveSiteModel(config, 'specialist').modelName).toBe('claude-haiku-4-5-20251001');
  });

  it('balanced uses premium for main, mid for specialist, cheap for rewriter', () => {
    const config = makeConfig({ modelMode: 'balanced' });
    expect(resolveSiteModel(config, 'main').modelName).toBe('claude-opus-4-6');
    expect(resolveSiteModel(config, 'specialist').modelName).toBe('claude-sonnet-4-5-20250929');
    expect(resolveSiteModel(config, 'rewriter').modelName).toBe('claude-haiku-4-5-20251001');
  });

  it('optimize-performance uses premium everywhere', () => {
    const config = makeConfig({ modelMode: 'optimize-performance' });
    for (const site of ['main', 'specialist', 'rewriter', 'tool-wrapper'] as const) {
      expect(resolveSiteModel(config, site).modelName).toBe('claude-opus-4-6');
    }
  });

  it('records source = "policy" with tier metadata', () => {
    const r = resolveSiteModel(makeConfig({ modelMode: 'balanced' }), 'main');
    expect(r.source).toBe('policy');
    expect(r.tier).toBe('premium');
  });
});

describe('resolveSiteModel — tier mapping per mode (openai)', () => {
  it('balanced picks gpt-5.2 / gpt-4.1 / gpt-4.1-mini', () => {
    const config = makeConfig({
      provider: 'openai',
      model: 'gpt-5.2',
      modelMode: 'balanced',
    });
    expect(resolveSiteModel(config, 'main').modelName).toBe('gpt-5.2');
    expect(resolveSiteModel(config, 'specialist').modelName).toBe('gpt-4.1');
    expect(resolveSiteModel(config, 'rewriter').modelName).toBe('gpt-4.1-mini');
  });
});

describe('resolveSiteModel — tier mapping per mode (xai)', () => {
  it('optimize-tokens picks fast-non-reasoning for main, grok-3-mini for rewriter', () => {
    const config = makeConfig({
      provider: 'xai',
      model: 'grok-4-fast-non-reasoning',
      modelMode: 'optimize-tokens',
    });
    expect(resolveSiteModel(config, 'main').modelName).toBe('grok-4-fast-non-reasoning');
    expect(resolveSiteModel(config, 'rewriter').modelName).toBe('grok-3-mini');
  });
});

describe('resolveSiteModel — precedence', () => {
  it('invocation override beats policy tier', () => {
    const config = makeConfig({ modelMode: 'balanced' });
    const r = resolveSiteModel(config, 'main', {
      overrides: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    });
    expect(r.modelName).toBe('claude-haiku-4-5-20251001');
    expect(r.source).toBe('override');
  });

  it('specialist override beats policy tier', () => {
    const config = makeConfig({ modelMode: 'optimize-performance' });
    const specialist = {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    } as Specialist;
    const r = resolveSiteModel(config, 'specialist', { specialist });
    expect(r.modelName).toBe('claude-haiku-4-5-20251001');
    expect(r.source).toBe('specialist');
  });

  it('invocation override beats specialist override', () => {
    const config = makeConfig({ modelMode: 'balanced' });
    const specialist = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
    } as Specialist;
    const r = resolveSiteModel(config, 'specialist', {
      specialist,
      overrides: { model: 'claude-opus-4-6' },
    });
    expect(r.modelName).toBe('claude-opus-4-6');
    expect(r.source).toBe('override');
  });

  it('blank/whitespace override falls through to policy', () => {
    const config = makeConfig({ modelMode: 'balanced' });
    const r = resolveSiteModel(config, 'rewriter', {
      overrides: { provider: '', model: '   ' },
    });
    expect(r.modelName).toBe('claude-haiku-4-5-20251001');
    expect(r.source).toBe('policy');
  });
});

describe('resolveSiteModel — fallbacks', () => {
  it('custom provider falls back to config.model regardless of mode', () => {
    const config = makeConfig({
      provider: 'ollama',
      model: 'llama3.2',
      modelMode: 'balanced',
      customProviders: {
        ollama: {
          sdk: 'openai',
          baseURL: 'http://localhost:11434/v1',
          defaultModel: 'llama3.2',
          models: ['llama3.2'],
        },
      },
      apiKeys: { ollama: 'sk-ollama' },
    });
    const r = resolveSiteModel(config, 'rewriter');
    expect(r.provider).toBe('ollama');
    expect(r.modelName).toBe('llama3.2');
    expect(r.source).toBe('fallback');
  });

  it('missing API key for active provider falls back to config.model', () => {
    const config = makeConfig({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      modelMode: 'balanced',
      anthropicApiKey: undefined,
      apiKeys: {},
    });
    const r = resolveSiteModel(config, 'rewriter');
    expect(r.modelName).toBe('claude-sonnet-4-5-20250929');
    expect(r.source).toBe('fallback');
  });
});

describe('resolveSiteModel — every mode is total', () => {
  const sites = [
    'main',
    'specialist',
    'tool-wrapper',
    'rewriter',
    'reference-resolver',
    'reference-lookup',
    'compressor',
    'specialist-detector',
  ] as const;
  const modes: ModelMode[] = ['off', 'optimize-tokens', 'balanced', 'optimize-performance'];
  for (const mode of modes) {
    for (const site of sites) {
      it(`mode=${mode} site=${site} resolves without throwing`, () => {
        const r = resolveSiteModel(makeConfig({ modelMode: mode }), site);
        expect(r.modelName).toBeTruthy();
        expect(r.provider).toBe('anthropic');
      });
    }
  }
});
