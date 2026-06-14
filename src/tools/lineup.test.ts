import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Each test gets an isolated BERNARD_HOME so loadLineups() seeds a fresh
// anthropic/openai/xai set and saveLineup() writes to a throwaway dir.
async function load() {
  vi.resetModules();
  const lineups = await import('../lineups.js');
  const { createLineupTool } = await import('./lineup.js');
  return { lineups, createLineupTool };
}

type ToolArgs = {
  action: 'list' | 'update' | 'create';
  id?: string;
  name?: string;
  base?: string;
  slots?: Array<{ role: string; tier: string; provider: string; model: string }>;
  activate?: boolean;
};

describe('lineup_edit tool', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-lineup-tool-'));
    origHome = process.env.BERNARD_HOME;
    process.env.BERNARD_HOME = tmpDir;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.BERNARD_HOME;
    else process.env.BERNARD_HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const run = async (args: ToolArgs, config?: unknown): Promise<string> => {
    const { createLineupTool } = await load();
    const t = createLineupTool(config as never);
    return (t.execute as (a: ToolArgs) => Promise<string>)(args);
  };

  it('lists existing lineups and marks the active one', async () => {
    const out = await run({ action: 'list' }, { provider: 'openai', model: 'x' });
    expect(out).toContain('Anthropic-only');
    expect(out).toContain('OpenAI-only');
    expect(out).toContain('[active]'); // openai resolves active via provider name
  });

  it('updates a single role/tier slot and persists it', async () => {
    const out = await run({
      action: 'update',
      id: 'openai',
      slots: [{ role: 'orchestrator', tier: 'premium', provider: 'openai', model: 'MY-MODEL' }],
    });
    expect(out).toContain('Updated lineup');

    const { lineups } = await load();
    const reloaded = lineups.loadLineups()['openai'];
    expect(reloaded.roles.orchestrator.premium).toEqual({ provider: 'openai', model: 'MY-MODEL' });
    // Other roles untouched.
    expect(reloaded.roles.executor.premium.model).not.toBe('MY-MODEL');
  });

  it('role="all" fans a tier binding out across every role', async () => {
    await run({
      action: 'update',
      id: 'xai',
      slots: [{ role: 'all', tier: 'cheap', provider: 'xai', model: 'CHEAP-ALL' }],
    });
    const { lineups } = await load();
    const reloaded = lineups.loadLineups()['xai'];
    for (const roleId of Object.keys(reloaded.roles)) {
      expect(reloaded.roles[roleId as keyof typeof reloaded.roles].cheap.model).toBe('CHEAP-ALL');
    }
  });

  it('refuses an update with an unknown id and lists the options', async () => {
    const out = await run({
      action: 'update',
      id: 'does-not-exist',
      slots: [{ role: 'orchestrator', tier: 'mid', provider: 'openai', model: 'm' }],
    });
    expect(out).toContain('No lineup with id "does-not-exist"');
    expect(out).toContain('anthropic');
    expect(out).toContain('openai');
  });

  it('creates a new lineup, cloning unspecified slots from the base/active', async () => {
    const out = await run(
      {
        action: 'create',
        name: 'My Mix',
        slots: [{ role: 'orchestrator', tier: 'premium', provider: 'anthropic', model: 'claude-x' }],
      },
      { provider: 'openai', model: 'x' },
    );
    expect(out).toContain('Created lineup "My Mix"');

    const { lineups } = await load();
    const all = lineups.loadLineups();
    const created = all['my-mix'];
    expect(created).toBeDefined();
    // The one specified slot is applied...
    expect(created.roles.orchestrator.premium).toEqual({ provider: 'anthropic', model: 'claude-x' });
    // ...and the rest are inherited from the active (openai) base, so they're valid.
    expect(created.roles.executor.premium.provider).toBe('openai');
  });

  it('activates a created lineup when activate=true (mutates config + persists prefs)', async () => {
    const savePreferences = vi.fn();
    vi.doMock('../config.js', async () => {
      const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
      return { ...actual, savePreferences };
    });
    vi.resetModules();
    const { createLineupTool } = await import('./lineup.js');
    const config = { provider: 'openai', model: 'x', activeLineupId: undefined as string | undefined };
    const t = createLineupTool(config as never);
    const out = await (t.execute as (a: ToolArgs) => Promise<string>)({
      action: 'create',
      name: 'Active One',
      activate: true,
    });
    expect(out).toContain('now active');
    expect(config.activeLineupId).toBe('active-one');
    expect(savePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ activeLineupId: 'active-one' }),
    );
    vi.doUnmock('../config.js');
  });

  it('warns when a slot references a provider with no configured key', async () => {
    const out = await run(
      {
        action: 'update',
        id: 'openai',
        slots: [{ role: 'orchestrator', tier: 'premium', provider: 'mystery-co', model: 'm' }],
      },
      { provider: 'openai', model: 'x', customProviders: {} },
    );
    expect(out).toContain('Updated lineup');
    expect(out).toContain('mystery-co');
    expect(out).toContain('no configured API key');
  });
});
