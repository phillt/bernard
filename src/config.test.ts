import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getDefaultModel,
  getAvailableProviders,
  loadConfig,
  PROVIDER_MODELS,
  saveProviderKey,
  getProviderKeyStatus,
  PROVIDER_ENV_VARS,
  saveOption,
  resetOption,
  resetAllOptions,
  OPTIONS_REGISTRY,
} from './config.js';
import type { BernardConfig } from './config.js';

vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => {
    throw new Error('ENOENT');
  }),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const fsMock = (await import('node:fs')) as unknown as {
  existsSync: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
  chmodSync: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
};

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
      ragEnabled: true,
    };
    expect(getAvailableProviders(config)).toEqual([]);
  });

  it('returns only providers with keys set', () => {
    const config: BernardConfig = {
      provider: 'anthropic',
      model: 'test',
      maxTokens: 4096,
      shellTimeout: 30000,
      ragEnabled: true,
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
      ragEnabled: true,
      anthropicApiKey: 'sk-ant-test',
      openaiApiKey: 'sk-openai-test',
      xaiApiKey: 'xai-test',
    };
    expect(getAvailableProviders(config)).toEqual(['anthropic', 'openai', 'xai']);
  });
});

describe('saveProviderKey', () => {
  beforeEach(() => {
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    fsMock.writeFileSync.mockReturnValue(undefined);
    fsMock.chmodSync.mockReturnValue(undefined);
    fsMock.mkdirSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws for unknown provider', () => {
    expect(() => saveProviderKey('unknown', 'key-123')).toThrow(/Unknown provider "unknown"/);
  });

  it('writes key to keys.json and calls chmodSync', () => {
    fsMock.existsSync.mockReturnValue(true);

    saveProviderKey('anthropic', 'sk-ant-test');

    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('keys.json'),
      expect.stringContaining('"anthropic": "sk-ant-test"'),
    );
    expect(fsMock.chmodSync).toHaveBeenCalledWith(expect.stringContaining('keys.json'), 0o600);
  });

  it('creates directory if it does not exist', () => {
    fsMock.existsSync.mockReturnValue(false);

    saveProviderKey('openai', 'sk-openai-test');

    expect(fsMock.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it('merges with existing keys', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ anthropic: 'existing-key' }));

    saveProviderKey('openai', 'sk-openai-test');

    const writtenData = JSON.parse(fsMock.writeFileSync.mock.calls[0][1] as string);
    expect(writtenData.anthropic).toBe('existing-key');
    expect(writtenData.openai).toBe('sk-openai-test');
  });
});

describe('getProviderKeyStatus', () => {
  beforeEach(() => {
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('XAI_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns all providers with hasKey false when no keys exist', () => {
    const statuses = getProviderKeyStatus();
    expect(statuses).toEqual([
      { provider: 'anthropic', hasKey: false },
      { provider: 'openai', hasKey: false },
      { provider: 'xai', hasKey: false },
    ]);
  });

  it('reflects env vars', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    const statuses = getProviderKeyStatus();
    const anthropic = statuses.find((s) => s.provider === 'anthropic');
    expect(anthropic?.hasKey).toBe(true);
  });

  it('reflects stored keys', () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ openai: 'sk-openai-test' }));
    const statuses = getProviderKeyStatus();
    const openai = statuses.find((s) => s.provider === 'openai');
    expect(openai?.hasKey).toBe(true);
  });
});

describe('loadConfig', () => {
  beforeEach(() => {
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
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
    vi.restoreAllMocks();
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

  it('throws on missing API key with add-key suggestion', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(() => loadConfig({ provider: 'anthropic' })).toThrow(/bernard add-key/);
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

  it('injects stored keys into process.env', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ anthropic: 'stored-ant-key' }));

    const config = loadConfig();
    expect(config.anthropicApiKey).toBe('stored-ant-key');
  });

  it('stored prefs.maxTokens overrides env var', () => {
    vi.stubEnv('BERNARD_MAX_TOKENS', '2048');
    // readFileSync is called twice: once for keys.json (throws), once for preferences.json
    let callCount = 0;
    fsMock.readFileSync.mockImplementation(() => {
      callCount++;
      // keys.json reads throw, preferences.json returns our data
      if (callCount <= 1) throw new Error('ENOENT');
      return JSON.stringify({ provider: 'anthropic', model: 'test', maxTokens: 8192 });
    });
    const config = loadConfig();
    expect(config.maxTokens).toBe(8192);
  });

  it('stored prefs.shellTimeout overrides env var', () => {
    vi.stubEnv('BERNARD_SHELL_TIMEOUT', '10000');
    let callCount = 0;
    fsMock.readFileSync.mockImplementation(() => {
      callCount++;
      if (callCount <= 1) throw new Error('ENOENT');
      return JSON.stringify({ provider: 'anthropic', model: 'test', shellTimeout: 60000 });
    });
    const config = loadConfig();
    expect(config.shellTimeout).toBe(60000);
  });

  it('falls back to env vars when no stored prefs for options', () => {
    vi.stubEnv('BERNARD_MAX_TOKENS', '2048');
    vi.stubEnv('BERNARD_SHELL_TIMEOUT', '10000');
    const config = loadConfig();
    expect(config.maxTokens).toBe(2048);
    expect(config.shellTimeout).toBe(10000);
  });

  it('falls back to defaults when neither stored prefs nor env vars exist', () => {
    const config = loadConfig();
    expect(config.maxTokens).toBe(4096);
    expect(config.shellTimeout).toBe(30000);
  });

  describe('provider auto-detection', () => {
    it('selects xai when only xai has a key and no provider is explicitly set', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('OPENAI_API_KEY', '');
      vi.stubEnv('XAI_API_KEY', 'xai-test-key');
      const config = loadConfig();
      expect(config.provider).toBe('xai');
      expect(config.model).toBe(PROVIDER_MODELS.xai[0]);
    });

    it('selects openai when only openai has a key and no provider is explicitly set', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
      vi.stubEnv('XAI_API_KEY', '');
      const config = loadConfig();
      expect(config.provider).toBe('openai');
      expect(config.model).toBe(PROVIDER_MODELS.openai[0]);
    });

    it('does not auto-detect when provider is explicitly set via override', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('XAI_API_KEY', 'xai-test-key');
      expect(() => loadConfig({ provider: 'anthropic' })).toThrow(/No API key found/);
    });

    it('does not auto-detect when provider is set via env var', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('BERNARD_PROVIDER', 'anthropic');
      vi.stubEnv('XAI_API_KEY', 'xai-test-key');
      expect(() => loadConfig()).toThrow(/No API key found/);
    });

    it('uses stored key for auto-detection', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('OPENAI_API_KEY', '');
      vi.stubEnv('XAI_API_KEY', '');
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ xai: 'stored-xai-key' }));
      const config = loadConfig();
      expect(config.provider).toBe('xai');
    });

    it('prefers openai over xai when both have keys (iteration order)', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
      vi.stubEnv('XAI_API_KEY', 'xai-test-key');
      const config = loadConfig();
      expect(config.provider).toBe('openai');
      expect(config.model).toBe(PROVIDER_MODELS.openai[0]);
    });

    it('preserves explicitly set model when provider is auto-detected via override', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('OPENAI_API_KEY', '');
      vi.stubEnv('XAI_API_KEY', 'xai-test-key');
      const config = loadConfig({ model: 'my-custom-model' });
      expect(config.provider).toBe('xai');
      expect(config.model).toBe('my-custom-model');
    });

    it('preserves explicitly set model when provider is auto-detected via env var', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('OPENAI_API_KEY', '');
      vi.stubEnv('XAI_API_KEY', 'xai-test-key');
      vi.stubEnv('BERNARD_MODEL', 'env-custom-model');
      const config = loadConfig();
      expect(config.provider).toBe('xai');
      expect(config.model).toBe('env-custom-model');
    });

    it('does not auto-detect when provider is set via stored preferences', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('XAI_API_KEY', 'xai-test-key');
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ provider: 'anthropic' }));
      fsMock.existsSync.mockReturnValue(true);
      expect(() => loadConfig()).toThrow(/No API key found/);
    });

    it('throws a helpful error when no provider keys are configured', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('OPENAI_API_KEY', '');
      vi.stubEnv('XAI_API_KEY', '');
      expect(() => loadConfig()).toThrow(/No API key found/);
    });

    it('skips auto-detection when default provider already has a key', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
      vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
      vi.stubEnv('XAI_API_KEY', 'xai-test-key');
      const config = loadConfig();
      expect(config.provider).toBe('anthropic');
      expect(config.model).toBe(PROVIDER_MODELS.anthropic[0]);
    });
  });
});

describe('saveOption', () => {
  beforeEach(() => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({ provider: 'anthropic', model: 'test-model' }),
    );
    fsMock.writeFileSync.mockReturnValue(undefined);
    fsMock.mkdirSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws for unknown option name', () => {
    expect(() => saveOption('unknown', 100)).toThrow(/Unknown option "unknown"/);
  });

  it('writes correct value to preferences.json', () => {
    saveOption('max-tokens', 8192);
    const writtenData = JSON.parse(fsMock.writeFileSync.mock.calls[0][1] as string);
    expect(writtenData.maxTokens).toBe(8192);
  });

  it('preserves existing provider/model when saving', () => {
    saveOption('shell-timeout', 60000);
    const writtenData = JSON.parse(fsMock.writeFileSync.mock.calls[0][1] as string);
    expect(writtenData.provider).toBe('anthropic');
    expect(writtenData.model).toBe('test-model');
    expect(writtenData.shellTimeout).toBe(60000);
  });
});

describe('resetOption', () => {
  beforeEach(() => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        provider: 'anthropic',
        model: 'test-model',
        maxTokens: 8192,
        shellTimeout: 60000,
      }),
    );
    fsMock.writeFileSync.mockReturnValue(undefined);
    fsMock.mkdirSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws for unknown option name', () => {
    expect(() => resetOption('unknown')).toThrow(/Unknown option "unknown"/);
  });

  it('removes the option from preferences.json', () => {
    resetOption('max-tokens');
    const writtenData = JSON.parse(fsMock.writeFileSync.mock.calls[0][1] as string);
    expect(writtenData.maxTokens).toBeUndefined();
  });

  it('preserves other options and provider/model', () => {
    resetOption('max-tokens');
    const writtenData = JSON.parse(fsMock.writeFileSync.mock.calls[0][1] as string);
    expect(writtenData.provider).toBe('anthropic');
    expect(writtenData.model).toBe('test-model');
    expect(writtenData.shellTimeout).toBe(60000);
  });
});

describe('resetAllOptions', () => {
  beforeEach(() => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        provider: 'openai',
        model: 'gpt-4o-mini',
        maxTokens: 8192,
        shellTimeout: 60000,
      }),
    );
    fsMock.writeFileSync.mockReturnValue(undefined);
    fsMock.mkdirSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes all option keys from preferences.json', () => {
    resetAllOptions();
    const writtenData = JSON.parse(fsMock.writeFileSync.mock.calls[0][1] as string);
    expect(writtenData.maxTokens).toBeUndefined();
    expect(writtenData.shellTimeout).toBeUndefined();
  });

  it('preserves provider/model', () => {
    resetAllOptions();
    const writtenData = JSON.parse(fsMock.writeFileSync.mock.calls[0][1] as string);
    expect(writtenData.provider).toBe('openai');
    expect(writtenData.model).toBe('gpt-4o-mini');
  });
});
