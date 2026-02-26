import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

const home = os.homedir();

// Save original env vars
const origEnv = { ...process.env };

function clearXdgEnv() {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CACHE_HOME;
  delete process.env.XDG_STATE_HOME;
  delete process.env.BERNARD_HOME;
}

async function loadPaths() {
  vi.resetModules();
  return import('./paths.js');
}

describe('paths', () => {
  beforeEach(() => {
    clearXdgEnv();
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(origEnv)) {
      if (val !== undefined) process.env[key] = val;
    }
  });

  describe('defaults (no XDG env vars)', () => {
    it('CONFIG_DIR defaults to ~/.config/bernard', async () => {
      const paths = await loadPaths();
      expect(paths.CONFIG_DIR).toBe(path.join(home, '.config', 'bernard'));
    });

    it('DATA_DIR defaults to ~/.local/share/bernard', async () => {
      const paths = await loadPaths();
      expect(paths.DATA_DIR).toBe(path.join(home, '.local', 'share', 'bernard'));
    });

    it('CACHE_DIR defaults to ~/.cache/bernard', async () => {
      const paths = await loadPaths();
      expect(paths.CACHE_DIR).toBe(path.join(home, '.cache', 'bernard'));
    });

    it('STATE_DIR defaults to ~/.local/state/bernard', async () => {
      const paths = await loadPaths();
      expect(paths.STATE_DIR).toBe(path.join(home, '.local', 'state', 'bernard'));
    });

    it('LEGACY_DIR points to ~/.bernard', async () => {
      const paths = await loadPaths();
      expect(paths.LEGACY_DIR).toBe(path.join(home, '.bernard'));
    });
  });

  describe('XDG env var overrides', () => {
    it('XDG_CONFIG_HOME overrides config base', async () => {
      process.env.XDG_CONFIG_HOME = '/custom/config';
      const paths = await loadPaths();
      expect(paths.CONFIG_DIR).toBe(path.join('/custom/config', 'bernard'));
    });

    it('XDG_DATA_HOME overrides data base', async () => {
      process.env.XDG_DATA_HOME = '/custom/data';
      const paths = await loadPaths();
      expect(paths.DATA_DIR).toBe(path.join('/custom/data', 'bernard'));
    });

    it('XDG_CACHE_HOME overrides cache base', async () => {
      process.env.XDG_CACHE_HOME = '/custom/cache';
      const paths = await loadPaths();
      expect(paths.CACHE_DIR).toBe(path.join('/custom/cache', 'bernard'));
    });

    it('XDG_STATE_HOME overrides state base', async () => {
      process.env.XDG_STATE_HOME = '/custom/state';
      const paths = await loadPaths();
      expect(paths.STATE_DIR).toBe(path.join('/custom/state', 'bernard'));
    });
  });

  describe('relative XDG values are ignored (per spec)', () => {
    it('ignores relative XDG_CONFIG_HOME', async () => {
      process.env.XDG_CONFIG_HOME = 'relative/path';
      const paths = await loadPaths();
      expect(paths.CONFIG_DIR).toBe(path.join(home, '.config', 'bernard'));
    });

    it('ignores relative XDG_DATA_HOME', async () => {
      process.env.XDG_DATA_HOME = './relative';
      const paths = await loadPaths();
      expect(paths.DATA_DIR).toBe(path.join(home, '.local', 'share', 'bernard'));
    });
  });

  describe('BERNARD_HOME overrides all categories', () => {
    it('sets all dirs to the same base when BERNARD_HOME is set', async () => {
      process.env.BERNARD_HOME = '/tmp/bernard-test';
      const paths = await loadPaths();
      expect(paths.CONFIG_DIR).toBe(path.join('/tmp/bernard-test', 'bernard'));
      expect(paths.DATA_DIR).toBe(path.join('/tmp/bernard-test', 'bernard'));
      expect(paths.CACHE_DIR).toBe(path.join('/tmp/bernard-test', 'bernard'));
      expect(paths.STATE_DIR).toBe(path.join('/tmp/bernard-test', 'bernard'));
    });

    it('BERNARD_HOME takes precedence over XDG env vars', async () => {
      process.env.BERNARD_HOME = '/tmp/bernard-flat';
      process.env.XDG_CONFIG_HOME = '/custom/config';
      const paths = await loadPaths();
      expect(paths.CONFIG_DIR).toBe(path.join('/tmp/bernard-flat', 'bernard'));
    });

    it('ignores relative BERNARD_HOME', async () => {
      process.env.BERNARD_HOME = 'relative/home';
      const paths = await loadPaths();
      // Should fall through to defaults
      expect(paths.CONFIG_DIR).toBe(path.join(home, '.config', 'bernard'));
    });
  });

  describe('all exported paths are absolute', () => {
    it('every exported path is absolute with defaults', async () => {
      const paths = await loadPaths();
      const pathExports = [
        paths.CONFIG_DIR,
        paths.DATA_DIR,
        paths.CACHE_DIR,
        paths.STATE_DIR,
        paths.LEGACY_DIR,
        paths.PREFS_PATH,
        paths.KEYS_PATH,
        paths.ENV_PATH,
        paths.MCP_CONFIG_PATH,
        paths.MEMORY_DIR,
        paths.RAG_DIR,
        paths.MEMORIES_FILE,
        paths.LAST_SESSION_FILE,
        paths.CRON_DIR,
        paths.CRON_JOBS_FILE,
        paths.CRON_ALERTS_DIR,
        paths.MODELS_DIR,
        paths.UPDATE_CACHE_PATH,
        paths.HISTORY_FILE,
        paths.LOGS_DIR,
        paths.CRON_PID_FILE,
        paths.CRON_LOG_FILE,
      ];
      for (const p of pathExports) {
        expect(path.isAbsolute(p), `Expected absolute: ${p}`).toBe(true);
      }
    });
  });

  describe('file paths are under correct categories', () => {
    it('config files are under CONFIG_DIR', async () => {
      const paths = await loadPaths();
      expect(paths.PREFS_PATH.startsWith(paths.CONFIG_DIR)).toBe(true);
      expect(paths.KEYS_PATH.startsWith(paths.CONFIG_DIR)).toBe(true);
      expect(paths.ENV_PATH.startsWith(paths.CONFIG_DIR)).toBe(true);
      expect(paths.MCP_CONFIG_PATH.startsWith(paths.CONFIG_DIR)).toBe(true);
    });

    it('data files are under DATA_DIR', async () => {
      const paths = await loadPaths();
      expect(paths.MEMORY_DIR.startsWith(paths.DATA_DIR)).toBe(true);
      expect(paths.RAG_DIR.startsWith(paths.DATA_DIR)).toBe(true);
      expect(paths.MEMORIES_FILE.startsWith(paths.DATA_DIR)).toBe(true);
      expect(paths.CRON_DIR.startsWith(paths.DATA_DIR)).toBe(true);
      expect(paths.CRON_JOBS_FILE.startsWith(paths.DATA_DIR)).toBe(true);
    });

    it('cache files are under CACHE_DIR', async () => {
      const paths = await loadPaths();
      expect(paths.MODELS_DIR.startsWith(paths.CACHE_DIR)).toBe(true);
      expect(paths.UPDATE_CACHE_PATH.startsWith(paths.CACHE_DIR)).toBe(true);
    });

    it('state files are under STATE_DIR', async () => {
      const paths = await loadPaths();
      expect(paths.HISTORY_FILE.startsWith(paths.STATE_DIR)).toBe(true);
      expect(paths.LOGS_DIR.startsWith(paths.STATE_DIR)).toBe(true);
      expect(paths.CRON_PID_FILE.startsWith(paths.STATE_DIR)).toBe(true);
      expect(paths.CRON_LOG_FILE.startsWith(paths.STATE_DIR)).toBe(true);
    });
  });
});
