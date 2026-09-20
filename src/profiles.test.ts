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
    // Legacy v1 blob is migrated to v2 rules on read (#261); garbage dropped.
    expect(prefs.toolPermissions).toEqual([
      { effect: 'allow', tool: 'shell', specifier: 'ls *', _v: 2 },
    ]);
  });

  it('loadPreferences drops prototype-pollution keys from toolPermissions (#212)', async () => {
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
              // JSON.parse produces these as own properties; assigning them
              // onto a plain object would rewire its prototype.
              toolPermissions: {
                'shell:ls': 'allow',
                __proto__: 'allow',
                constructor: 'deny',
                prototype: 'allow',
              },
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
    // Forbidden keys are dropped during migration; only the real grant survives.
    expect(prefs.toolPermissions).toEqual([
      { effect: 'allow', tool: 'shell', specifier: 'ls *', _v: 2 },
    ]);
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

  // The OTHER `'off'` migration (#606). `readLegacyPreferences` carried a
  // hand-written copy of the same three-member list plus its own `'off'` arm,
  // on the one-shot `preferences.json` → `profiles.json` path — redundant,
  // since its output passes through `parseSettings` afterwards, and untested,
  // which is why the list could sit there through every change to the others.
  // It asks `normalizeStoredModelMode` now, so a fourth mode is handled rather
  // than silently dropped for want of an `else`.
  it('ingests a legacy preferences.json modelMode="off" as "optimize-performance"', async () => {
    const configDir = path.join(tmpDir, 'bernard');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'preferences.json'),
      JSON.stringify({ provider: 'anthropic', model: 'm', modelMode: 'off' }),
    );
    const m = await loadModule();
    const loaded = m.loadProfiles();
    expect(loaded.migratedFromPreferences).toBe(true);
    expect(m.getActiveSettings(loaded.file).modelMode).toBe('optimize-performance');
  });

  it('drops a legacy preferences.json modelMode it cannot read', async () => {
    // Guard the guard: the case above passes for an ingest that copies the
    // string through unvalidated, which is what the collapse must not become.
    const configDir = path.join(tmpDir, 'bernard');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'preferences.json'),
      JSON.stringify({ provider: 'anthropic', model: 'm', modelMode: 'nonsense' }),
    );
    const m = await loadModule();
    expect(m.getActiveSettings(m.loadProfiles().file).modelMode).toBeUndefined();
  });
});

/**
 * The two writers #377 needed: one that reads the stored rules, and one that
 * crosses profiles.
 */
describe('profile rules and cross-profile edits', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-profile-rules-'));
    origHome = process.env.BERNARD_HOME;
    process.env.BERNARD_HOME = tmpDir;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.BERNARD_HOME;
    else process.env.BERNARD_HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const rule = (tool: string) => ({ effect: 'allow' as const, tool, _v: 2 as const });

  it('reads the rules as stored, not a copy held from before', async () => {
    // The whole point: `config.toolPermissions` is an in-memory array the REPL
    // mutates, and anything else that writes `profiles.json` mid-session leaves
    // it stale. A writer composing from the stale copy writes the other
    // writer's removals back. This reader is what the writers compose from now.
    const m = await loadModule();
    m.saveActiveSettings({ toolPermissions: [rule('shell'), rule('web_read')] });
    const captured = m.loadActiveProfileRules();

    // Somebody else prunes a rule, the way the MCP sweep does.
    m.saveActiveSettings({ toolPermissions: [rule('web_read')] });

    expect(captured.map((r) => r.tool)).toEqual(['shell', 'web_read']);
    expect(m.loadActiveProfileRules().map((r) => r.tool)).toEqual(['web_read']);
  });

  it('migrates a legacy v1 blob on read rather than handing it back raw', async () => {
    const m = await loadModule();
    m.saveActiveSettings({ toolPermissions: { web_read: 'allow' } });
    const rules = m.loadActiveProfileRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ tool: 'web_read', effect: 'allow', _v: 2 });
  });

  it('edits every profile in one write and leaves the others alone', async () => {
    const m = await loadModule();
    m.saveActiveSettings({ toolPermissions: [rule('shell')] });
    const work = m.createProfile('Work', { toolPermissions: [rule('shell'), rule('web_read')] });
    m.createProfile('Spare', { toolPermissions: [rule('web_read')] });

    m.updateAllProfileSettings((settings) => {
      const kept = (settings.toolPermissions as ReturnType<typeof rule>[]).filter(
        (r) => r.tool !== 'shell',
      );
      return kept.length === (settings.toolPermissions as unknown[]).length
        ? null
        : { ...settings, toolPermissions: kept };
    });

    const file = m.loadProfiles().file;
    expect(file.profiles['default'].settings.toolPermissions).toEqual([]);
    expect(file.profiles[work.id].settings.toolPermissions).toEqual([rule('web_read')]);
  });

  it('does not rewrite the file when every profile is left alone', async () => {
    // A no-op sweep must not re-stamp `updatedAt` on every profile.
    //
    // Asserted against a **non-canonical** file on purpose: `writeFile`
    // re-serializes with `JSON.stringify(file, null, 2)`, so an unconditional
    // write of an unchanged object produces byte-identical output and a
    // before/after comparison of a file Bernard wrote passes either way —
    // measured, that is exactly what the first version of this test did. Odd
    // spacing is what makes "was it written?" observable at all.
    const m = await loadModule();
    m.saveActiveSettings({ toolPermissions: [rule('shell')] });
    const file = path.join(tmpDir, 'bernard', 'profiles.json');
    const scruffy = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf-8')), null, 4);
    fs.writeFileSync(file, scruffy);

    m.updateAllProfileSettings(() => null);

    expect(fs.readFileSync(file, 'utf-8')).toBe(scruffy);
  });
});
