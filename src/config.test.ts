import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDefaultModel, getAvailableProviders, loadConfig, PROVIDER_MODELS } from './config.js';
import type { BernardConfig } from './config.js';

vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
}));

describe('getDefaultModel', () => {
  it('returns the first model for anthropic', () => {
    expect(getDefaultModel('anthropic')).toBe(PROVIDER_MODELS.anthropic[0]);
  });

  it('returns the first model for openai', () => {
    expect(getDefaultModel('openai')).toBe(PROVIDER_MODELS.openai[0]);
  });

  it('returns the first model for xai', () => {
    expect(getDefaultModel('xai')).toBe(PROVIDER_MODELS.xai[0]);
  });

  it('falls back to anthropic default for unknown provider', () => {
    expect(getDefaultModel('unknown')).toBe(PROVIDER_MODELS.anthropic[0]);
  });
});

describe('getAvailableProviders', () => {
  it('returns empty array when no API keys are set', () => {
    const config: BernardConfig = {
      provider: 'anthropic',
      model: 'test',
      maxTokens: 4096,
      shellTimeout: 30000,
    };
    expect(getAvailableProviders(config)).toEqual([]);
  });

  it('returns only providers with keys set', () => {
    const config: BernardConfig = {
      provider: 'anthropic',
      model: 'test',
      maxTokens: 4096,
      shellTimeout: 30000,
      anthropicApiKey: 'sk-ant-test',
      openaiApiKey: 'sk-openai-test',
    };
    expect(getAvailableProviders(config)).toEqual(['anthropic', 'openai']);
  });

  it('returns all providers when all keys are set', () => {
    const config: BernardConfig = {
      provider: 'anthropic',
      model: 'test',
      maxTokens: 4096,
      shellTimeout: 30000,
      anthropicApiKey: 'sk-ant-test',
      openaiApiKey: 'sk-openai-test',
      xaiApiKey: 'xai-test',
    };
    expect(getAvailableProviders(config)).toEqual(['anthropic', 'openai', 'xai']);
  });
});

describe('loadConfig', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('XAI_API_KEY', '');
    vi.stubEnv('BERNARD_PROVIDER', '');
    vi.stubEnv('BERNARD_MODEL', '');
    vi.stubEnv('BERNARD_MAX_TOKENS', '');
    vi.stubEnv('BERNARD_SHELL_TIMEOUT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses defaults when no overrides or env vars', () => {
    const config = loadConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe(PROVIDER_MODELS.anthropic[0]);
    expect(config.maxTokens).toBe(4096);
    expect(config.shellTimeout).toBe(30000);
  });

  it('overrides take priority over env vars', () => {
    vi.stubEnv('BERNARD_PROVIDER', 'openai');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
    const config = loadConfig({ provider: 'anthropic' });
    expect(config.provider).toBe('anthropic');
  });

  it('uses env vars as fallback', () => {
    vi.stubEnv('BERNARD_PROVIDER', 'openai');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
    const config = loadConfig();
    expect(config.provider).toBe('openai');
  });

  it('throws on missing API key', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(() => loadConfig({ provider: 'anthropic' })).toThrow(/No API key found/);
  });

  it('parses BERNARD_MAX_TOKENS', () => {
    vi.stubEnv('BERNARD_MAX_TOKENS', '8192');
    const config = loadConfig();
    expect(config.maxTokens).toBe(8192);
  });

  it('parses BERNARD_SHELL_TIMEOUT', () => {
    vi.stubEnv('BERNARD_SHELL_TIMEOUT', '60000');
    const config = loadConfig();
    expect(config.shellTimeout).toBe(60000);
  });

  it('reads API keys from process.env', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'ant-key');
    vi.stubEnv('OPENAI_API_KEY', 'oai-key');
    vi.stubEnv('XAI_API_KEY', 'xai-key');
    const config = loadConfig();
    expect(config.anthropicApiKey).toBe('ant-key');
    expect(config.openaiApiKey).toBe('oai-key');
    expect(config.xaiApiKey).toBe('xai-key');
  });
});
