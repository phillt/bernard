import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BernardConfig } from './config.js';
import type { Specialist } from './specialists.js';

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

async function loadModule() {
  vi.resetModules();
  return import('./model-policy.js');
}

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
    modelMode: 'balanced',
    subagentPac: true,
    toolDetails: false,
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    correctionEnabled: true,
    promptRewriter: true,
    referenceLookup: true,
    referenceLookupTools: [],
    scratchSubjectThreshold: 0.15,
    conciseMode: true,
    anthropicApiKey: 'sk-ant',
    openaiApiKey: 'sk-openai',
    xaiApiKey: 'xai-key',
    apiKeys: { anthropic: 'sk-ant', openai: 'sk-openai', xai: 'xai-key' },
    customProviders: {},
    ...overrides,
  };
}

let tmpDir: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-model-policy-'));
  origHome = process.env.BERNARD_HOME;
  process.env.BERNARD_HOME = tmpDir;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.BERNARD_HOME;
  else process.env.BERNARD_HOME = origHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveSiteModel — tier mapping per mode (anthropic lineup)', () => {
  it('optimize-tokens uses mid for main, cheap for rewriter', async () => {
    const { resolveSiteModel } = await loadModule();
    const config = makeConfig({ modelMode: 'optimize-tokens' });
    expect(resolveSiteModel(config, 'main').modelName).toBe('claude-sonnet-4-5-20250929');
    expect(resolveSiteModel(config, 'rewriter').modelName).toBe('claude-haiku-4-5-20251001');
    expect(resolveSiteModel(config, 'specialist').modelName).toBe('claude-haiku-4-5-20251001');
  });

  it('balanced uses premium for main, mid for specialist, cheap for rewriter', async () => {
    const { resolveSiteModel } = await loadModule();
    const config = makeConfig({ modelMode: 'balanced' });
    expect(resolveSiteModel(config, 'main').modelName).toBe('claude-opus-4-6');
    expect(resolveSiteModel(config, 'specialist').modelName).toBe('claude-sonnet-4-5-20250929');
    expect(resolveSiteModel(config, 'rewriter').modelName).toBe('claude-haiku-4-5-20251001');
  });

  it('optimize-performance uses premium everywhere', async () => {
    const { resolveSiteModel } = await loadModule();
    const config = makeConfig({ modelMode: 'optimize-performance' });
    for (const site of ['main', 'specialist', 'rewriter', 'tool-wrapper'] as const) {
      expect(resolveSiteModel(config, site).modelName).toBe('claude-opus-4-6');
    }
  });

  it('records source = "policy" with tier metadata', async () => {
    const { resolveSiteModel } = await loadModule();
    const r = resolveSiteModel(makeConfig({ modelMode: 'balanced' }), 'main');
    expect(r.source).toBe('policy');
    expect(r.tier).toBe('premium');
  });
});

describe('resolveSiteModel — openai lineup', () => {
  it('balanced picks gpt-5.2 / gpt-4.1 / gpt-4.1-mini', async () => {
    const { resolveSiteModel } = await loadModule();
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

describe('resolveSiteModel — xai lineup', () => {
  it('optimize-tokens picks fast-non-reasoning for main, grok-3-mini for rewriter', async () => {
    const { resolveSiteModel } = await loadModule();
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
  it('invocation override beats policy tier', async () => {
    const { resolveSiteModel } = await loadModule();
    const config = makeConfig({ modelMode: 'balanced' });
    const r = resolveSiteModel(config, 'main', {
      overrides: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    });
    expect(r.modelName).toBe('claude-haiku-4-5-20251001');
    expect(r.source).toBe('override');
  });

  it('specialist override beats policy tier', async () => {
    const { resolveSiteModel } = await loadModule();
    const config = makeConfig({ modelMode: 'optimize-performance' });
    const specialist = {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    } as Specialist;
    const r = resolveSiteModel(config, 'specialist', { specialist });
    expect(r.modelName).toBe('claude-haiku-4-5-20251001');
    expect(r.source).toBe('specialist');
  });

  it('invocation override beats specialist override', async () => {
    const { resolveSiteModel } = await loadModule();
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

  it('blank/whitespace override falls through to policy', async () => {
    const { resolveSiteModel } = await loadModule();
    const config = makeConfig({ modelMode: 'balanced' });
    const r = resolveSiteModel(config, 'rewriter', {
      overrides: { provider: '', model: '   ' },
    });
    expect(r.modelName).toBe('claude-haiku-4-5-20251001');
    expect(r.source).toBe('policy');
  });
});

describe('resolveSiteModel — cross-provider lineup', () => {
  it('honors a lineup that mixes providers across tiers', async () => {
    // Seed a cross-provider lineup; resolver should pick each slot's provider.
    fs.mkdirSync(path.join(tmpDir, 'bernard'), { recursive: true });
    const lineupsPath = path.join(tmpDir, 'bernard', 'lineups.json');
    fs.writeFileSync(
      lineupsPath,
      JSON.stringify({
        lineups: {
          mixed: {
            id: 'mixed',
            name: 'Mixed',
            premium: { provider: 'anthropic', model: 'claude-opus-4-6' },
            mid: { provider: 'openai', model: 'gpt-4.1' },
            cheap: { provider: 'xai', model: 'grok-3-mini' },
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );

    const { resolveSiteModel } = await loadModule();
    const config = makeConfig({ modelMode: 'balanced', activeLineupId: 'mixed' });
    expect(resolveSiteModel(config, 'main').modelName).toBe('claude-opus-4-6');
    expect(resolveSiteModel(config, 'main').provider).toBe('anthropic');
    expect(resolveSiteModel(config, 'specialist').modelName).toBe('gpt-4.1');
    expect(resolveSiteModel(config, 'specialist').provider).toBe('openai');
    expect(resolveSiteModel(config, 'rewriter').modelName).toBe('grok-3-mini');
    expect(resolveSiteModel(config, 'rewriter').provider).toBe('xai');
  });
});

describe('resolveSiteModel — fallbacks', () => {
  it('lineup slot with no API key falls back to config provider/model', async () => {
    const { resolveSiteModel } = await loadModule();
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
  const modes = ['optimize-tokens', 'balanced', 'optimize-performance'] as const;
  for (const mode of modes) {
    for (const site of sites) {
      it(`mode=${mode} site=${site} resolves without throwing`, async () => {
        const { resolveSiteModel } = await loadModule();
        const r = resolveSiteModel(makeConfig({ modelMode: mode }), site);
        expect(r.modelName).toBeTruthy();
        expect(r.provider).toBe('anthropic');
      });
    }
  }
});

describe('normalizeStoredModelMode', () => {
  it('migrates legacy "off" to "optimize-performance"', async () => {
    const { normalizeStoredModelMode } = await loadModule();
    expect(normalizeStoredModelMode('off')).toBe('optimize-performance');
  });

  it('passes through valid modes', async () => {
    const { normalizeStoredModelMode } = await loadModule();
    expect(normalizeStoredModelMode('balanced')).toBe('balanced');
    expect(normalizeStoredModelMode('optimize-tokens')).toBe('optimize-tokens');
    expect(normalizeStoredModelMode('optimize-performance')).toBe('optimize-performance');
  });

  it('returns undefined for unknown values', async () => {
    const { normalizeStoredModelMode } = await loadModule();
    expect(normalizeStoredModelMode('nonsense')).toBeUndefined();
    expect(normalizeStoredModelMode(undefined)).toBeUndefined();
    expect(normalizeStoredModelMode(null)).toBeUndefined();
  });
});
