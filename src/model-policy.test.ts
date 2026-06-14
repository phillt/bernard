import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BernardConfig } from './config.js';
import type { Specialist } from './specialists.js';
import { fullRoles } from './__tests__/lineup-fixtures.js';

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
  isDebugEnabled: vi.fn(() => false),
  getSessionId: vi.fn(() => 'test'),
  getSessionLogPath: vi.fn(() => '/tmp/test.jsonl'),
}));

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

/**
 * Pins the built-in provider lineups so these tests stay deterministic. The
 * resolver normally seeds from the dynamic model catalog (Vercel AI Gateway),
 * which would re-tier whenever the gateway updates prices.
 */
function seedTestLineups(dir: string): void {
  const cfgDir = path.join(dir, 'bernard');
  fs.mkdirSync(cfgDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(cfgDir, 'lineups.json'),
    JSON.stringify(
      {
        lineups: {
          anthropic: {
            id: 'anthropic',
            name: 'Anthropic-only',
            roles: fullRoles({
              premium: { provider: 'anthropic', model: 'claude-opus-4-6' },
              mid: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
              cheap: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
            }),
            createdAt: now,
            updatedAt: now,
          },
          openai: {
            id: 'openai',
            name: 'OpenAI-only',
            roles: fullRoles({
              premium: { provider: 'openai', model: 'gpt-5.2' },
              mid: { provider: 'openai', model: 'gpt-4.1' },
              cheap: { provider: 'openai', model: 'gpt-4.1-mini' },
            }),
            createdAt: now,
            updatedAt: now,
          },
          xai: {
            id: 'xai',
            name: 'xAI-only',
            roles: fullRoles({
              premium: { provider: 'xai', model: 'grok-4-1-fast-reasoning' },
              mid: { provider: 'xai', model: 'grok-4-fast-non-reasoning' },
              cheap: { provider: 'xai', model: 'grok-3-mini' },
            }),
            createdAt: now,
            updatedAt: now,
          },
        },
      },
      null,
      2,
    ),
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-model-policy-'));
  origHome = process.env.BERNARD_HOME;
  process.env.BERNARD_HOME = tmpDir;
  seedTestLineups(tmpDir);
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

describe('resolveMainModel (#233)', () => {
  it('returns the same model name as resolveSiteModel(config, "main")', async () => {
    const { resolveMainModel, resolveSiteModel } = await loadModule();
    const config = makeConfig({ modelMode: 'balanced' });
    expect(resolveMainModel(config)).toBe(resolveSiteModel(config, 'main').modelName);
    expect(resolveMainModel(config)).toBe('claude-opus-4-6');
  });

  it('tracks the active lineup, not the stale config.model base field', async () => {
    // The bug scenario: base fields still point at a large-window xAI model
    // while an OpenAI-only optimize-performance lineup re-tiers main to gpt-5.2.
    // Window math must follow the lineup, not config.model.
    const { resolveMainModel } = await loadModule();
    const config = makeConfig({
      provider: 'xai',
      model: 'grok-4-fast-non-reasoning',
      activeLineupId: 'openai',
      modelMode: 'optimize-performance',
    });
    expect(resolveMainModel(config)).toBe('gpt-5.2');
    expect(resolveMainModel(config)).not.toBe(config.model);
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
            roles: fullRoles({
              premium: { provider: 'anthropic', model: 'claude-opus-4-6' },
              mid: { provider: 'openai', model: 'gpt-4.1' },
              cheap: { provider: 'xai', model: 'grok-3-mini' },
            }),
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

describe('resolveSiteModel — off-lineup specialist pin guard', () => {
  it('drops a specialist pin whose provider is not in the active lineup', async () => {
    const m = await loadModule();
    const logger = await import('./logger.js');
    const spy = logger.debugLog as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();
    m._resetModelPolicyLogCacheForTests();

    // xAI-only lineup, but a stale specialist pin from when the user was on OpenAI.
    const config = makeConfig({
      provider: 'xai',
      model: 'grok-4-fast-non-reasoning',
      modelMode: 'balanced',
      activeLineupId: 'xai',
    });
    const specialist = { provider: 'openai', model: 'gpt-5.2' } as Specialist;
    const r = m.resolveSiteModel(config, 'tool-wrapper', { specialist });

    expect(r.provider).toBe('xai');
    expect(r.source).toBe('policy');
    expect(r.modelName).toBe('grok-4-fast-non-reasoning');

    const offLineupCalls = spy.mock.calls.filter(
      (c) => c[0] === 'model-policy:specialist-off-lineup',
    );
    expect(offLineupCalls).toHaveLength(1);
    expect(offLineupCalls[0][1]).toMatchObject({
      site: 'tool-wrapper',
      specialistProvider: 'openai',
      lineupId: 'xai',
    });
  });

  it('keeps a specialist pin whose provider is in the active lineup', async () => {
    const m = await loadModule();
    const config = makeConfig({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      modelMode: 'balanced',
      activeLineupId: 'anthropic',
    });
    const specialist = {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    } as Specialist;
    const r = m.resolveSiteModel(config, 'specialist', { specialist });
    expect(r.source).toBe('specialist');
    expect(r.modelName).toBe('claude-haiku-4-5-20251001');
  });

  it('keeps a custom-provider pin even when off-lineup (deliberate local binding)', async () => {
    const m = await loadModule();
    const logger = await import('./logger.js');
    const spy = logger.debugLog as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    // xAI-only lineup, but the specialist is deliberately pinned to a custom
    // Ollama endpoint — privacy/cost intent the guard must never reroute to
    // a remote API.
    const config = makeConfig({
      provider: 'xai',
      model: 'grok-4-fast-non-reasoning',
      modelMode: 'balanced',
      activeLineupId: 'xai',
      customProviders: {
        ollama: {
          name: 'ollama',
          sdk: 'openai',
          baseURL: 'http://localhost:11434/v1',
          defaultModel: 'llama3.2',
          models: ['llama3.2'],
        },
      },
      apiKeys: { anthropic: 'sk-ant', openai: 'sk-openai', xai: 'xai-key', ollama: 'local' },
    });
    const specialist = { provider: 'ollama', model: 'llama3.2' } as Specialist;
    const r = m.resolveSiteModel(config, 'tool-wrapper', { specialist });

    expect(r.source).toBe('specialist');
    expect(r.provider).toBe('ollama');
    expect(r.modelName).toBe('llama3.2');
    const offLineupCalls = spy.mock.calls.filter(
      (c) => c[0] === 'model-policy:specialist-off-lineup',
    );
    expect(offLineupCalls).toHaveLength(0);
  });

  it('invocation override bypasses the off-lineup guard', async () => {
    const m = await loadModule();
    const config = makeConfig({
      provider: 'xai',
      model: 'grok-4-fast-non-reasoning',
      modelMode: 'balanced',
      activeLineupId: 'xai',
    });
    // Specialist pin would be dropped, but explicit override wins.
    const specialist = { provider: 'openai', model: 'gpt-5.2' } as Specialist;
    const r = m.resolveSiteModel(config, 'tool-wrapper', {
      specialist,
      overrides: { provider: 'openai', model: 'gpt-4.1' },
    });
    expect(r.source).toBe('override');
    expect(r.provider).toBe('openai');
    expect(r.modelName).toBe('gpt-4.1');
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

describe('snapshotSiteModels', () => {
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

  it('returns one entry per ModelSite with a provider/model populated', async () => {
    const { snapshotSiteModels } = await loadModule();
    const snap = snapshotSiteModels(
      makeConfig({ modelMode: 'balanced', activeLineupId: 'anthropic' }),
    );
    expect(snap.modelMode).toBe('balanced');
    expect(snap.lineup.id).toBe('anthropic');
    for (const s of sites) {
      expect(snap.sites[s]).toBeDefined();
      expect(snap.sites[s].provider).toBeTruthy();
      expect(snap.sites[s].model).toBeTruthy();
      expect(['cheap', 'mid', 'premium']).toContain(snap.sites[s].tier);
      expect(snap.sites[s].source).toBe('policy');
    }
  });

  it('reflects mode shifts (balanced → optimize-tokens moves main from premium to mid)', async () => {
    const { snapshotSiteModels } = await loadModule();
    const bal = snapshotSiteModels(makeConfig({ modelMode: 'balanced' }));
    const opt = snapshotSiteModels(makeConfig({ modelMode: 'optimize-tokens' }));
    expect(bal.sites.main.tier).toBe('premium');
    expect(opt.sites.main.tier).toBe('mid');
  });

  it('marks source="fallback" when the lineup slot points at a provider with no key', async () => {
    const { snapshotSiteModels } = await loadModule();
    const snap = snapshotSiteModels(
      makeConfig({
        modelMode: 'balanced',
        anthropicApiKey: undefined,
        apiKeys: {},
      }),
    );
    expect(snap.sites.main.source).toBe('fallback');
  });
});

describe('logSiteModelSnapshot', () => {
  it('emits the full snapshot on session-start, then diffs on follow-ups', async () => {
    const m = await loadModule();
    const logger = await import('./logger.js');
    const spy = logger.debugLog as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();
    m._resetSnapshotCacheForTests();

    const config = makeConfig({ modelMode: 'balanced', activeLineupId: 'anthropic' });
    m.logSiteModelSnapshot(config, 'session-start');
    const startCalls = spy.mock.calls.filter((c) => c[0] === 'model-policy:snapshot');
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0][1]).toMatchObject({ reason: 'session-start' });
    expect((startCalls[0][1] as { snapshot?: unknown }).snapshot).toBeDefined();

    spy.mockClear();
    config.modelMode = 'optimize-tokens';
    m.logSiteModelSnapshot(config, 'model-mode-change');
    const followCalls = spy.mock.calls.filter((c) => c[0] === 'model-policy:snapshot');
    expect(followCalls).toHaveLength(1);
    const payload = followCalls[0][1] as { reason: string; changed: unknown[] };
    expect(payload.reason).toBe('model-mode-change');
    expect(Array.isArray(payload.changed)).toBe(true);
    expect(payload.changed.length).toBeGreaterThan(0);
  });

  it('emits an empty changed array when nothing actually shifts', async () => {
    const m = await loadModule();
    const logger = await import('./logger.js');
    const spy = logger.debugLog as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();
    m._resetSnapshotCacheForTests();

    const config = makeConfig({ modelMode: 'balanced', activeLineupId: 'anthropic' });
    m.logSiteModelSnapshot(config, 'session-start');
    spy.mockClear();
    m.logSiteModelSnapshot(config, 'lineup-change');
    const calls = spy.mock.calls.filter((c) => c[0] === 'model-policy:snapshot');
    expect(calls).toHaveLength(1);
    expect((calls[0][1] as { changed: unknown[] }).changed).toEqual([]);
  });
});

describe('resolveSiteModel — override-path logging (regression)', () => {
  it('emits model-policy:resolve with source="specialist" when a specialist override wins', async () => {
    const m = await loadModule();
    const logger = await import('./logger.js');
    const spy = logger.debugLog as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();
    m._resetModelPolicyLogCacheForTests();

    // Pin the specialist to a provider that IS in the active lineup — the
    // off-lineup guard would otherwise (correctly) drop the pin.
    const config = makeConfig({ modelMode: 'balanced', activeLineupId: 'anthropic' });
    const specialist = {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    } as Specialist;
    m.resolveSiteModel(config, 'tool-wrapper', { specialist });

    const resolveCalls = spy.mock.calls.filter((c) => c[0] === 'model-policy:resolve');
    expect(resolveCalls.length).toBeGreaterThan(0);
    const last = resolveCalls[resolveCalls.length - 1][1] as {
      site: string;
      source: string;
      provider: string;
    };
    expect(last.site).toBe('tool-wrapper');
    expect(last.source).toBe('specialist');
    expect(last.provider).toBe('anthropic');
  });
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
