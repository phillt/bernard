import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let testDir: string;
let legacyDir: string;

// Mock os.homedir() so paths.ts resolves to our test directory
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: vi.fn(() => actual.homedir()),
  };
});

const origEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
  }
  for (const [key, val] of Object.entries(origEnv)) {
    if (val !== undefined) process.env[key] = val;
  }
}

function setTestHome() {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CACHE_HOME;
  delete process.env.XDG_STATE_HOME;
  delete process.env.BERNARD_HOME;
  vi.mocked(os.homedir).mockReturnValue(testDir);
}

async function importMigrate() {
  vi.resetModules();
  return import('./migrate.js');
}

describe('migrateFromLegacy', () => {
  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-migrate-'));
    legacyDir = path.join(testDir, '.bernard');
    setTestHome();
  });

  afterEach(() => {
    restoreEnv();
    vi.mocked(os.homedir).mockRestore();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('no-op when legacy dir does not exist', async () => {
    // Don't create legacyDir — it doesn't exist
    const { migrateFromLegacy } = await importMigrate();
    const result = migrateFromLegacy();
    expect(result.migrated).toBe(false);
    expect(result.errors).toHaveLength(0);
  });

  it('no-op when BERNARD_HOME is set', async () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'preferences.json'), '{}');
    process.env.BERNARD_HOME = path.join(testDir, 'flat');
    const { migrateFromLegacy } = await importMigrate();
    const result = migrateFromLegacy();
    expect(result.migrated).toBe(false);
  });

  it('no-op when MIGRATED marker already exists', async () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'MIGRATED'), 'already done');
    const { migrateFromLegacy } = await importMigrate();
    const result = migrateFromLegacy();
    expect(result.migrated).toBe(false);
  });

  it('no-op when prefs already exist in XDG config dir', async () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    const xdgConfig = path.join(testDir, '.config', 'bernard');
    fs.mkdirSync(xdgConfig, { recursive: true });
    fs.writeFileSync(path.join(xdgConfig, 'preferences.json'), '{}');
    const { migrateFromLegacy } = await importMigrate();
    const result = migrateFromLegacy();
    expect(result.migrated).toBe(false);
  });

  it('no-op when CONFIG_DIR has any files (e.g. keys.json from add-key)', async () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'preferences.json'), '{}');
    const xdgConfig = path.join(testDir, '.config', 'bernard');
    fs.mkdirSync(xdgConfig, { recursive: true });
    fs.writeFileSync(path.join(xdgConfig, 'keys.json'), '{"anthropic":"sk-test"}');
    const { migrateFromLegacy } = await importMigrate();
    const result = migrateFromLegacy();
    expect(result.migrated).toBe(false);
  });

  it('migrates config files to CONFIG_DIR', async () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'preferences.json'), '{"provider":"openai"}');
    fs.writeFileSync(path.join(legacyDir, 'mcp.json'), '{"mcpServers":{}}');

    const { migrateFromLegacy } = await importMigrate();
    const result = migrateFromLegacy();
    expect(result.migrated).toBe(true);
    expect(result.errors).toHaveLength(0);

    const configDir = path.join(testDir, '.config', 'bernard');
    expect(fs.existsSync(path.join(configDir, 'preferences.json'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'mcp.json'))).toBe(true);
    const prefs = fs.readFileSync(path.join(configDir, 'preferences.json'), 'utf-8');
    expect(JSON.parse(prefs).provider).toBe('openai');
  });

  it('preserves 0600 permissions on keys.json', async () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'keys.json'), '{"anthropic":"sk-test"}');
    fs.chmodSync(path.join(legacyDir, 'keys.json'), 0o600);

    const { migrateFromLegacy } = await importMigrate();
    migrateFromLegacy();

    const keysPath = path.join(testDir, '.config', 'bernard', 'keys.json');
    expect(fs.existsSync(keysPath)).toBe(true);
    const stat = fs.statSync(keysPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('migrates data directories to DATA_DIR', async () => {
    fs.mkdirSync(path.join(legacyDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'memory', 'notes.md'), '# Notes');
    fs.mkdirSync(path.join(legacyDir, 'rag'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'rag', 'memories.json'), '[]');

    const { migrateFromLegacy } = await importMigrate();
    const result = migrateFromLegacy();
    expect(result.migrated).toBe(true);

    const dataDir = path.join(testDir, '.local', 'share', 'bernard');
    expect(fs.existsSync(path.join(dataDir, 'memory', 'notes.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'memory', 'notes.md'), 'utf-8')).toBe('# Notes');
    expect(fs.existsSync(path.join(dataDir, 'rag', 'memories.json'))).toBe(true);
  });

  it('migrates cache files to CACHE_DIR', async () => {
    fs.mkdirSync(path.join(legacyDir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'models', 'model.bin'), 'binary-data');

    const { migrateFromLegacy } = await importMigrate();
    migrateFromLegacy();

    expect(fs.existsSync(path.join(testDir, '.cache', 'bernard', 'models', 'model.bin'))).toBe(
      true,
    );
  });

  it('migrates update-check.json to CACHE_DIR', async () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'update-check.json'), '{"lastCheck":123}');

    const { migrateFromLegacy } = await importMigrate();
    const result = migrateFromLegacy();
    expect(result.migrated).toBe(true);

    const cacheDir = path.join(testDir, '.cache', 'bernard');
    expect(fs.existsSync(path.join(cacheDir, 'update-check.json'))).toBe(true);
    const content = fs.readFileSync(path.join(cacheDir, 'update-check.json'), 'utf-8');
    expect(JSON.parse(content).lastCheck).toBe(123);
  });

  it('migrates state files to STATE_DIR', async () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'conversation-history.json'), '[]');
    fs.mkdirSync(path.join(legacyDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'logs', 'job1.jsonl'), '{}');

    const { migrateFromLegacy } = await importMigrate();
    migrateFromLegacy();

    const stateDir = path.join(testDir, '.local', 'state', 'bernard');
    expect(fs.existsSync(path.join(stateDir, 'conversation-history.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'logs', 'job1.jsonl'))).toBe(true);
  });

  it('creates MIGRATED marker after migration', async () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'preferences.json'), '{}');

    const { migrateFromLegacy } = await importMigrate();
    migrateFromLegacy();

    const markerPath = path.join(legacyDir, 'MIGRATED');
    expect(fs.existsSync(markerPath)).toBe(true);
    const content = fs.readFileSync(markerPath, 'utf-8');
    expect(content).toContain('XDG');
  });

  it('continues on individual file failure and returns errors', async () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'preferences.json'), '{}');
    // Create memory dir with a file, then make the file unreadable
    fs.mkdirSync(path.join(legacyDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'memory', 'test.md'), 'content');
    // Make memory dir read-only so renaming out of it fails
    fs.chmodSync(path.join(legacyDir, 'memory'), 0o444);

    const { migrateFromLegacy } = await importMigrate();
    const result = migrateFromLegacy();
    // Restore permissions so cleanup works
    fs.chmodSync(path.join(legacyDir, 'memory'), 0o755);
    expect(result.migrated).toBe(true);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.includes('memory'))).toBe(true);
    // preferences.json should still have been migrated despite the memory/ error
    expect(fs.existsSync(path.join(testDir, '.config', 'bernard', 'preferences.json'))).toBe(true);
  });
});
