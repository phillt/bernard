import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ALL_ROLE_IDS } from './model-roles.js';

async function loadModule() {
  vi.resetModules();
  return import('./lineups.js');
}

type Slot = { provider: string; model: string };
type Ladder = { premium: Slot; mid: Slot; cheap: Slot };

/** Builds a full `role → ladder` map by replicating one ladder across roles. */
function fullRoles(ladder: Ladder): Record<string, Ladder> {
  const out: Record<string, Ladder> = {};
  for (const r of ALL_ROLE_IDS) {
    out[r] = {
      premium: { ...ladder.premium },
      mid: { ...ladder.mid },
      cheap: { ...ladder.cheap },
    };
  }
  return out;
}

const SAMPLE: Ladder = {
  premium: { provider: 'anthropic', model: 'claude-opus-4-6' },
  mid: { provider: 'openai', model: 'gpt-4.1' },
  cheap: { provider: 'xai', model: 'grok-3-mini' },
};

describe('lineups store', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-lineups-'));
    origHome = process.env.BERNARD_HOME;
    process.env.BERNARD_HOME = tmpDir;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.BERNARD_HOME;
    else process.env.BERNARD_HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('validateLineupId', () => {
    it('accepts valid ids and rejects malformed ones', async () => {
      const m = await loadModule();
      expect(m.validateLineupId('mixed')).toBeNull();
      expect(m.validateLineupId('my-lineup')).toBeNull();
      expect(m.validateLineupId('a1_b2')).toBeNull();
      expect(m.validateLineupId('')).toMatch(/empty/i);
      expect(m.validateLineupId('Mixed')).toMatch(/lowercase/);
      expect(m.validateLineupId('1lineup')).toMatch(/lowercase/);
      expect(m.validateLineupId('a'.repeat(33))).toMatch(/32 characters/);
    });
  });

  describe('validateLineupName', () => {
    it('rejects empty and overlong names', async () => {
      const m = await loadModule();
      expect(m.validateLineupName('   ')).toMatch(/empty/i);
      expect(m.validateLineupName('a'.repeat(65))).toMatch(/64 characters/);
      expect(m.validateLineupName('Mixed providers')).toBeNull();
    });
  });

  describe('slugifyLineupName / uniqueLineupId', () => {
    it('builds slugs and de-duplicates against existing ids', async () => {
      const m = await loadModule();
      expect(m.slugifyLineupName('Mixed Providers!')).toBe('mixed-providers');
      expect(m.slugifyLineupName('123 only digits')).toBe('l-123-only-digits');
      const existing = {
        mixed: {
          id: 'mixed',
          name: 'Mixed',
          roles: fullRoles(SAMPLE),
          createdAt: 'x',
          updatedAt: 'x',
        },
      } as never;
      expect(m.uniqueLineupId('Mixed', existing)).toBe('mixed-2');
    });
  });

  describe('loadLineups', () => {
    it('seeds three default lineups on first read', async () => {
      const m = await loadModule();
      const lineups = m.loadLineups();
      expect(Object.keys(lineups).sort()).toEqual(['anthropic', 'openai', 'xai']);
      // Models are derived dynamically from the catalog; assert structural
      // shape rather than exact names so a catalog refresh doesn't break this.
      for (const provider of ['anthropic', 'openai', 'xai'] as const) {
        // Every role is present and seeded to the same provider for all tiers.
        for (const role of ALL_ROLE_IDS) {
          const ladder = lineups[provider].roles[role];
          expect(ladder.premium.provider).toBe(provider);
          expect(ladder.mid.provider).toBe(provider);
          expect(ladder.cheap.provider).toBe(provider);
          expect(ladder.premium.model.length).toBeGreaterThan(0);
          expect(ladder.mid.model.length).toBeGreaterThan(0);
          expect(ladder.cheap.model.length).toBeGreaterThan(0);
        }
      }
    });

    it('persists the seed to disk', async () => {
      const m = await loadModule();
      m.loadLineups();
      const filePath = path.join(tmpDir, 'bernard', 'lineups.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(onDisk.lineups.anthropic.name).toBe('Anthropic-only');
      expect(onDisk.lineups.anthropic.roles.orchestrator.premium.provider).toBe('anthropic');
    });

    it('reseeds when the file is corrupt JSON', async () => {
      fs.mkdirSync(path.join(tmpDir, 'bernard'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'bernard', 'lineups.json'), 'not json');
      const m = await loadModule();
      const lineups = m.loadLineups();
      expect(lineups.anthropic).toBeDefined();
    });

    it('drops entries with missing slots and reseeds when result is empty', async () => {
      fs.mkdirSync(path.join(tmpDir, 'bernard'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'bernard', 'lineups.json'),
        JSON.stringify({ lineups: { junk: { id: 'junk', name: 'Junk' } } }),
      );
      const m = await loadModule();
      const lineups = m.loadLineups();
      expect(lineups.junk).toBeUndefined();
      expect(lineups.anthropic).toBeDefined();
    });
  });

  describe('migration (legacy flat → role-keyed)', () => {
    it('replicates a legacy flat lineup across all roles and rewrites the file', async () => {
      fs.mkdirSync(path.join(tmpDir, 'bernard'), { recursive: true });
      const filePath = path.join(tmpDir, 'bernard', 'lineups.json');
      // Pre-#264 flat shape: premium/mid/cheap at the top level, no `roles`.
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          lineups: {
            legacy: {
              id: 'legacy',
              name: 'Legacy',
              premium: SAMPLE.premium,
              mid: SAMPLE.mid,
              cheap: SAMPLE.cheap,
              createdAt: 'c',
              updatedAt: 'u',
            },
          },
        }),
      );
      const m = await loadModule();
      const lineups = m.loadLineups();
      expect(lineups.legacy).toBeDefined();
      // Every role inherits the old cost ladder verbatim.
      for (const role of ALL_ROLE_IDS) {
        expect(lineups.legacy.roles[role].premium).toEqual(SAMPLE.premium);
        expect(lineups.legacy.roles[role].mid).toEqual(SAMPLE.mid);
        expect(lineups.legacy.roles[role].cheap).toEqual(SAMPLE.cheap);
      }
      // The on-disk shape was upgraded: role-keyed, no top-level flat slots.
      const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(onDisk.lineups.legacy.roles).toBeDefined();
      expect(onDisk.lineups.legacy.premium).toBeUndefined();
    });

    it('backfills a role missing from a stored role-keyed lineup', async () => {
      fs.mkdirSync(path.join(tmpDir, 'bernard'), { recursive: true });
      const partial = fullRoles(SAMPLE);
      // Simulate a lineup saved before the `coder` role existed.
      delete partial.coder;
      fs.writeFileSync(
        path.join(tmpDir, 'bernard', 'lineups.json'),
        JSON.stringify({
          lineups: {
            partial: {
              id: 'partial',
              name: 'Partial',
              roles: partial,
              createdAt: 'c',
              updatedAt: 'u',
            },
          },
        }),
      );
      const m = await loadModule();
      const lineups = m.loadLineups();
      // coder is backfilled from the orchestrator anchor.
      expect(lineups.partial.roles.coder).toBeDefined();
      expect(lineups.partial.roles.coder.premium).toEqual(
        lineups.partial.roles.orchestrator.premium,
      );
    });
  });

  describe('resolveActiveLineup', () => {
    it('prefers the explicit id', async () => {
      const m = await loadModule();
      const lineups = m.loadLineups();
      expect(m.resolveActiveLineup(lineups, 'openai', 'anthropic').id).toBe('openai');
    });

    it('falls back to a lineup that matches the provider name', async () => {
      const m = await loadModule();
      const lineups = m.loadLineups();
      expect(m.resolveActiveLineup(lineups, undefined, 'xai').id).toBe('xai');
    });

    it('falls back to the first lineup when no id and no provider match', async () => {
      const m = await loadModule();
      const lineups = m.loadLineups();
      const first = Object.values(lineups)[0];
      expect(m.resolveActiveLineup(lineups, 'no-such-id', 'unknown-provider').id).toBe(first.id);
    });
  });

  describe('resolveActiveLineupWithCorrection', () => {
    it('reports no correction when the explicit id exists', async () => {
      const m = await loadModule();
      const lineups = m.loadLineups();
      const res = m.resolveActiveLineupWithCorrection(lineups, 'openai', 'anthropic');
      expect(res.lineup.id).toBe('openai');
      expect(res.corrected).toBeUndefined();
    });

    it('reports no correction when no explicit id is set (normal fallback)', async () => {
      const m = await loadModule();
      const lineups = m.loadLineups();
      const res = m.resolveActiveLineupWithCorrection(lineups, undefined, 'xai');
      expect(res.lineup.id).toBe('xai');
      expect(res.corrected).toBeUndefined();
    });

    it('reports a correction when the explicit id is missing, falling back by provider', async () => {
      const m = await loadModule();
      const lineups = m.loadLineups();
      const res = m.resolveActiveLineupWithCorrection(lineups, 'openai-only', 'xai');
      // 'openai-only' doesn't exist; provider 'xai' does → fall back to it.
      expect(res.lineup.id).toBe('xai');
      expect(res.corrected).toEqual({ requestedId: 'openai-only', resolvedId: 'xai' });
    });

    it('reports a correction and falls back to the first lineup when nothing matches', async () => {
      const m = await loadModule();
      const lineups = m.loadLineups();
      const first = Object.values(lineups)[0];
      const res = m.resolveActiveLineupWithCorrection(lineups, 'gone', 'unknown-provider');
      expect(res.lineup.id).toBe(first.id);
      expect(res.corrected).toEqual({ requestedId: 'gone', resolvedId: first.id });
    });
  });

  describe('saveLineup / renameLineup / deleteLineup', () => {
    it('writes a new lineup with a derived id', async () => {
      const m = await loadModule();
      const entry = m.saveLineup({
        name: 'My Mix',
        roles: fullRoles(SAMPLE) as never,
      });
      expect(entry.id).toBe('my-mix');
      expect(entry.roles.executor.mid.provider).toBe('openai');
      const all = m.loadLineups();
      expect(all['my-mix']).toBeDefined();
    });

    it('updates an existing lineup in place', async () => {
      const m = await loadModule();
      m.saveLineup({ id: 'mix', name: 'Mix', roles: fullRoles(SAMPLE) as never });
      const tweaked = fullRoles(SAMPLE);
      tweaked.executor.mid = { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' };
      const updated = m.saveLineup({ id: 'mix', name: 'Mix', roles: tweaked as never });
      expect(updated.roles.executor.mid.provider).toBe('anthropic');
      // Other roles untouched.
      expect(updated.roles.orchestrator.mid.provider).toBe('openai');
    });

    it('rejects empty slot fields with a role+tier message', async () => {
      const m = await loadModule();
      const bad = fullRoles(SAMPLE);
      bad.orchestrator.premium = { provider: '', model: 'x' };
      expect(() => m.saveLineup({ name: 'Bad', roles: bad as never })).toThrow(
        /orchestrator.*premium/,
      );
    });

    it('renameLineup updates the display name', async () => {
      const m = await loadModule();
      m.loadLineups();
      const renamed = m.renameLineup('anthropic', 'My Anthropic');
      expect(renamed.name).toBe('My Anthropic');
    });

    it('deleteLineup removes an entry but refuses the last one', async () => {
      const m = await loadModule();
      m.loadLineups();
      m.deleteLineup('openai');
      m.deleteLineup('xai');
      expect(() => m.deleteLineup('anthropic')).toThrow(/last remaining/);
    });
  });

  describe('atomic writes', () => {
    it('writes via a tmp file then rename (no partial file)', async () => {
      const m = await loadModule();
      m.loadLineups();
      // Disk should never contain `.lineups.json.tmp` leftovers after a successful write.
      const dir = path.join(tmpDir, 'bernard');
      const stray = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
      expect(stray).toEqual([]);
    });
  });
});
