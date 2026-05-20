import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

async function loadModule() {
  vi.resetModules();
  return import('./custom-providers.js');
}

describe('custom-providers store', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-custom-providers-'));
    origHome = process.env.BERNARD_HOME;
    process.env.BERNARD_HOME = tmpDir;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.BERNARD_HOME;
    else process.env.BERNARD_HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('validateProviderName', () => {
    it('accepts valid lowercase names', async () => {
      const m = await loadModule();
      expect(m.validateProviderName('ollama')).toBeNull();
      expect(m.validateProviderName('lm-studio')).toBeNull();
      expect(m.validateProviderName('local_proxy')).toBeNull();
      expect(m.validateProviderName('a1')).toBeNull();
    });

    it('rejects empty / malformed names', async () => {
      const m = await loadModule();
      expect(m.validateProviderName('')).toMatch(/empty/i);
      expect(m.validateProviderName('Ollama')).toMatch(/lowercase/i);
      expect(m.validateProviderName('1ollama')).toMatch(/lowercase letter/i);
      expect(m.validateProviderName('ollama!')).toMatch(/lowercase/i);
      expect(m.validateProviderName('a'.repeat(33))).toMatch(/32 characters/i);
    });

    it('rejects reserved built-in names', async () => {
      const m = await loadModule();
      expect(m.validateProviderName('anthropic')).toMatch(/built-in/i);
      expect(m.validateProviderName('openai')).toMatch(/built-in/i);
      expect(m.validateProviderName('xai')).toMatch(/built-in/i);
    });
  });

  describe('validateBaseURL', () => {
    it('accepts http and https URLs', async () => {
      const m = await loadModule();
      expect(m.validateBaseURL('http://localhost:11434/v1')).toBeNull();
      expect(m.validateBaseURL('https://api.openrouter.ai/v1')).toBeNull();
    });

    it('rejects empty / invalid / non-http URLs', async () => {
      const m = await loadModule();
      expect(m.validateBaseURL('')).toMatch(/empty/i);
      expect(m.validateBaseURL('not a url')).toMatch(/valid URL/i);
      expect(m.validateBaseURL('ftp://example.com')).toMatch(/http or https/i);
    });
  });

  describe('saveCustomProvider', () => {
    it('writes a new entry with defaultModel first in models[]', async () => {
      const m = await loadModule();
      const entry = m.saveCustomProvider({
        name: 'ollama',
        sdk: 'openai',
        baseURL: 'http://localhost:11434/v1',
        defaultModel: 'llama3.2',
      });
      expect(entry.models).toEqual(['llama3.2']);
      expect(entry.createdAt).toBeTruthy();
      expect(entry.updatedAt).toBeTruthy();

      const loaded = m.loadCustomProviders();
      expect(loaded.ollama.defaultModel).toBe('llama3.2');
      expect(loaded.ollama.sdk).toBe('openai');
      expect(loaded.ollama.baseURL).toBe('http://localhost:11434/v1');
    });

    it('throws on invalid name / sdk / baseURL', async () => {
      const m = await loadModule();
      expect(() =>
        m.saveCustomProvider({
          name: 'BadName',
          sdk: 'openai',
          baseURL: 'http://x',
          defaultModel: 'm',
        }),
      ).toThrow();
      expect(() =>
        m.saveCustomProvider({
          name: 'good',
          // @ts-expect-error - intentional bad sdk
          sdk: 'gemini',
          baseURL: 'http://x',
          defaultModel: 'm',
        }),
      ).toThrow();
      expect(() =>
        m.saveCustomProvider({
          name: 'good',
          sdk: 'openai',
          baseURL: 'not-a-url',
          defaultModel: 'm',
        }),
      ).toThrow();
      expect(() =>
        m.saveCustomProvider({
          name: 'good',
          sdk: 'openai',
          baseURL: 'http://x',
          defaultModel: '   ',
        }),
      ).toThrow();
    });

    it('preserves createdAt when updating an existing entry', async () => {
      const m = await loadModule();
      const first = m.saveCustomProvider({
        name: 'ollama',
        sdk: 'openai',
        baseURL: 'http://localhost:11434/v1',
        defaultModel: 'llama3.2',
      });
      // Force a perceivable wall-clock gap so updatedAt differs.
      await new Promise((r) => setTimeout(r, 5));
      const second = m.saveCustomProvider({
        name: 'ollama',
        sdk: 'openai',
        baseURL: 'http://localhost:11434/v1',
        defaultModel: 'mistral',
      });
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt).not.toBe(first.updatedAt);
      expect(second.defaultModel).toBe('mistral');
    });
  });

  describe('removeCustomProvider', () => {
    it('removes an entry and deletes file when empty', async () => {
      const m = await loadModule();
      m.saveCustomProvider({
        name: 'ollama',
        sdk: 'openai',
        baseURL: 'http://localhost:11434/v1',
        defaultModel: 'llama3.2',
      });
      m.removeCustomProvider('ollama');
      expect(m.loadCustomProviders()).toEqual({});
    });

    it('throws when the entry does not exist', async () => {
      const m = await loadModule();
      expect(() => m.removeCustomProvider('missing')).toThrow();
    });
  });

  describe('rememberCustomModel', () => {
    it('appends a new model and keeps default first', async () => {
      const m = await loadModule();
      m.saveCustomProvider({
        name: 'ollama',
        sdk: 'openai',
        baseURL: 'http://localhost:11434/v1',
        defaultModel: 'llama3.2',
      });
      m.rememberCustomModel('ollama', 'mistral');
      m.rememberCustomModel('ollama', 'qwen2.5-coder');
      const loaded = m.loadCustomProviders();
      expect(loaded.ollama.models[0]).toBe('llama3.2');
      expect(loaded.ollama.models).toContain('mistral');
      expect(loaded.ollama.models).toContain('qwen2.5-coder');
    });

    it('is idempotent for duplicate models', async () => {
      const m = await loadModule();
      m.saveCustomProvider({
        name: 'ollama',
        sdk: 'openai',
        baseURL: 'http://localhost:11434/v1',
        defaultModel: 'llama3.2',
      });
      m.rememberCustomModel('ollama', 'llama3.2');
      m.rememberCustomModel('ollama', 'mistral');
      m.rememberCustomModel('ollama', 'mistral');
      const loaded = m.loadCustomProviders();
      expect(loaded.ollama.models).toEqual(['llama3.2', 'mistral']);
    });

    it('no-ops for unknown providers', async () => {
      const m = await loadModule();
      // Should not throw.
      m.rememberCustomModel('does-not-exist', 'mistral');
      expect(m.loadCustomProviders()).toEqual({});
    });
  });

  describe('loadCustomProviders', () => {
    it('returns empty map when file does not exist', async () => {
      const m = await loadModule();
      expect(m.loadCustomProviders()).toEqual({});
    });

    it('returns empty map on corrupted JSON', async () => {
      const m = await loadModule();
      m.saveCustomProvider({
        name: 'ollama',
        sdk: 'openai',
        baseURL: 'http://localhost:11434/v1',
        defaultModel: 'llama3.2',
      });
      const { CUSTOM_PROVIDERS_PATH } = await import('./paths.js');
      fs.writeFileSync(CUSTOM_PROVIDERS_PATH, '{ corrupted');
      expect(m.loadCustomProviders()).toEqual({});
    });

    it('skips entries with invalid sdk values', async () => {
      const m = await loadModule();
      const { CUSTOM_PROVIDERS_PATH } = await import('./paths.js');
      const dir = path.dirname(CUSTOM_PROVIDERS_PATH);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        CUSTOM_PROVIDERS_PATH,
        JSON.stringify({
          providers: {
            good: {
              name: 'good',
              sdk: 'openai',
              baseURL: 'http://x.test',
              defaultModel: 'm',
              models: ['m'],
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
            bad: {
              name: 'bad',
              sdk: 'gemini',
              baseURL: 'http://y.test',
              defaultModel: 'm',
            },
          },
        }),
      );
      const loaded = m.loadCustomProviders();
      expect(loaded.good).toBeDefined();
      expect(loaded.bad).toBeUndefined();
    });
  });
});
