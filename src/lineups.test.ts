import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

async function loadModule() {
  vi.resetModules();
  return import('./lineups.js');
}

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
          premium: { provider: 'anthropic', model: 'claude-opus-4-6' },
          mid: { provider: 'anthropic', model: 'claude-sonnet' },
          cheap: { provider: 'anthropic', model: 'claude-haiku' },
          createdAt: 'x',
          updatedAt: 'x',
        },
      };
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
        expect(lineups[provider].premium.provider).toBe(provider);
        expect(lineups[provider].mid.provider).toBe(provider);
        expect(lineups[provider].cheap.provider).toBe(provider);
        expect(lineups[provider].premium.model.length).toBeGreaterThan(0);
        expect(lineups[provider].mid.model.length).toBeGreaterThan(0);
        expect(lineups[provider].cheap.model.length).toBeGreaterThan(0);
      }
    });

    it('persists the seed to disk', async () => {
      const m = await loadModule();
      m.loadLineups();
      const filePath = path.join(tmpDir, 'bernard', 'lineups.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(onDisk.lineups.anthropic.name).toBe('Anthropic-only');
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

  describe('saveLineup / renameLineup / deleteLineup', () => {
    it('writes a new lineup with a derived id', async () => {
      const m = await loadModule();
      const entry = m.saveLineup({
        name: 'My Mix',
        premium: { provider: 'anthropic', model: 'claude-opus-4-6' },
        mid: { provider: 'openai', model: 'gpt-4.1' },
        cheap: { provider: 'xai', model: 'grok-3-mini' },
      });
      expect(entry.id).toBe('my-mix');
      expect(entry.mid.provider).toBe('openai');
      const all = m.loadLineups();
      expect(all['my-mix']).toBeDefined();
    });

    it('updates an existing lineup in place', async () => {
      const m = await loadModule();
      m.saveLineup({
        id: 'mix',
        name: 'Mix',
        premium: { provider: 'anthropic', model: 'claude-opus-4-6' },
        mid: { provider: 'openai', model: 'gpt-4.1' },
        cheap: { provider: 'xai', model: 'grok-3-mini' },
      });
      const updated = m.saveLineup({
        id: 'mix',
        name: 'Mix',
        premium: { provider: 'anthropic', model: 'claude-opus-4-6' },
        mid: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
        cheap: { provider: 'xai', model: 'grok-3-mini' },
      });
      expect(updated.mid.provider).toBe('anthropic');
    });

    it('rejects empty slot fields', async () => {
      const m = await loadModule();
      expect(() =>
        m.saveLineup({
          name: 'Bad',
          premium: { provider: '', model: 'x' },
          mid: { provider: 'anthropic', model: 'x' },
          cheap: { provider: 'anthropic', model: 'x' },
        }),
      ).toThrow(/premium/);
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
