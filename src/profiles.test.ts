import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

async function loadModule() {
  vi.resetModules();
  return import('./profiles.js');
}

describe('profiles store', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-profiles-'));
    origHome = process.env.BERNARD_HOME;
    process.env.BERNARD_HOME = tmpDir;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.BERNARD_HOME;
    else process.env.BERNARD_HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips activeLineupId through save and load', async () => {
    const m = await loadModule();
    m.saveActiveSettings({ activeLineupId: 'mixed', modelMode: 'balanced' });
    vi.resetModules();
    const reloaded = await import('./profiles.js');
    const settings = reloaded.getActiveSettings(reloaded.loadProfiles().file);
    expect(settings.activeLineupId).toBe('mixed');
    expect(settings.modelMode).toBe('balanced');
  });

  it('round-trips toolPermissions and skipPermissions through save and load (#212)', async () => {
    const m = await loadModule();
    m.saveActiveSettings({
      toolPermissions: { 'shell:git': 'allow', web_read: 'deny' },
      skipPermissions: true,
    });
    vi.resetModules();
    const reloaded = await import('./profiles.js');
    const settings = reloaded.getActiveSettings(reloaded.loadProfiles().file);
    expect(settings.toolPermissions).toEqual({ 'shell:git': 'allow', web_read: 'deny' });
    expect(settings.skipPermissions).toBe(true);
  });

  it('loadPreferences filters garbage toolPermissions values (#212)', async () => {
    const configDir = path.join(tmpDir, 'bernard');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'profiles.json'),
      JSON.stringify({
        activeProfileId: 'default',
        profiles: {
          default: {
            id: 'default',
            name: 'Default',
            settings: {
              toolPermissions: { 'shell:ls': 'allow', bad: 'yolo', worse: 42 },
            },
            createdAt: 'x',
            updatedAt: 'x',
          },
        },
      }),
    );
    vi.resetModules();
    const config = await import('./config.js');
    const prefs = config.loadPreferences();
    expect(prefs.toolPermissions).toEqual({ 'shell:ls': 'allow' });
  });

  it('loadPreferences normalizes a legacy modelMode="off" on disk to "optimize-performance"', async () => {
    const configDir = path.join(tmpDir, 'bernard');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'profiles.json'),
      JSON.stringify({
        activeProfileId: 'default',
        profiles: {
          default: {
            id: 'default',
            name: 'Default',
            settings: { modelMode: 'off' },
            createdAt: 'x',
            updatedAt: 'x',
          },
        },
      }),
    );
    vi.resetModules();
    const config = await import('./config.js');
    const prefs = config.loadPreferences();
    expect(prefs.modelMode).toBe('optimize-performance');
  });
});
