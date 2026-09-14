import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ALL_ROLE_IDS } from './model-roles.js';
import { fullRoles, type Ladder } from './__tests__/lineup-fixtures.js';

async function loadModule() {
  vi.resetModules();
  return import('./lineups.js');
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

  // #447. Seeding used to derive tier models by ranking the Vercel AI Gateway
  // catalog by output price and taking the extremes, which handed Anthropic's
  // premium slot to `claude-opus-4` — retired, still listing its legacy
  // $75/MTok price, therefore top of the sort, and not dispatchable. Nothing
  // observed what the seed produced: the case below deliberately asserts
  // structural shape only ("so a catalog refresh doesn't break this"), and
  // `model-policy.test.ts` pre-writes `lineups.json` and never runs the seeder
  // at all. That two-sided blind spot is why it shipped.
  describe('seeded models (#447)', () => {
    it('seeds the curated table verbatim, not a catalog-derived ladder', async () => {
      const m = await loadModule();
      const lineups = m.loadLineups();
      for (const provider of ['anthropic', 'openai', 'xai'] as const) {
        const expected = m.DEFAULT_TIERS[provider];
        for (const role of ALL_ROLE_IDS) {
          const ladder = lineups[provider].roles[role];
          expect(ladder.premium.model).toBe(expected.premium);
          expect(ladder.mid.model).toBe(expected.mid);
          expect(ladder.cheap.model).toBe(expected.cheap);
        }
      }
    });

    // The regression itself, named. This is the one assertion that fails if
    // anyone reinstates catalog derivation, and it fails loudly enough to
    // explain itself.
    it('never seeds a model known not to dispatch', async () => {
      const m = await loadModule();
      const lineups = m.loadLineups();
      const seeded = new Set<string>();
      for (const lineup of Object.values(lineups)) {
        for (const role of ALL_ROLE_IDS) {
          for (const tier of ['premium', 'mid', 'cheap'] as const) {
            seeded.add(lineup.roles[role][tier].model);
          }
        }
      }
      // Measured 2026-09-14 against a live key: each of these is what the old
      // price-ranked derivation picked, and each fails a real probe.
      for (const dead of [
        'claude-opus-4',
        'gpt-oss-20b',
        'gpt-5.1-thinking',
        'grok-4.1-fast-reasoning',
        'grok-4.20-multi-agent',
      ]) {
        expect(seeded).not.toContain(dead);
      }
    });

    // Catalog membership is NOT a dispatchability check and must never be
    // mistaken for one — `grok-3-mini` dispatches and is in no snapshot, while
    // `grok-4.1-fast-reasoning` is in the snapshot and returns not_found. What
    // it does decide is whether pricing and the context window resolve, since
    // `getModelMeta` falls soft to 128k / `n/a` on a miss. That is worth
    // holding: a default whose spend cannot be priced is a poor default.
    it('seeds only models the catalog can price', async () => {
      const m = await loadModule();
      const { getModelMeta } = await import('./providers/catalog.js');
      for (const provider of ['anthropic', 'openai', 'xai'] as const) {
        const tiers = m.DEFAULT_TIERS[provider];
        for (const tier of ['premium', 'mid', 'cheap'] as const) {
          expect(getModelMeta(provider, tiers[tier]), `${provider}/${tiers[tier]}`).not.toBeNull();
        }
      }
    });
  });

  // The other half of #447: seeding correctly from now on fixes nobody who has
  // already run Bernard, including the person who reported it.
  describe('repair of a pre-#447 seed', () => {
    /** Exactly what the old price-ranked seeder wrote for this provider. */
    async function legacySeed(provider: 'anthropic' | 'openai' | 'xai') {
      const { getCatalogForProvider } = await import('./providers/catalog.js');
      const { deriveTiers } = await import('./providers/tiers.js');
      const tiers = deriveTiers(getCatalogForProvider(provider));
      return fullRoles({
        premium: { provider, model: tiers.premium },
        mid: { provider, model: tiers.mid },
        cheap: { provider, model: tiers.cheap },
      });
    }

    async function writeLineups(lineups: Record<string, unknown>): Promise<void> {
      const { LINEUPS_PATH } = await import('./paths.js');
      fs.mkdirSync(path.dirname(LINEUPS_PATH), { recursive: true });
      fs.writeFileSync(LINEUPS_PATH, JSON.stringify({ lineups }, null, 2));
    }

    const stamp = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

    it('rewrites a lineup whose every slot matches the old derivation', async () => {
      const m = await loadModule();
      await writeLineups({
        anthropic: {
          id: 'anthropic',
          name: 'Anthropic-only',
          roles: await legacySeed('anthropic'),
          ...stamp,
        },
      });
      const lineups = m.loadLineups();
      const ladder = lineups.anthropic.roles.orchestrator;
      // `premium` alone proves nothing: every legacy ladder now contains at
      // least one id on `DEAD_SEEDED_MODELS`, so the dead-slot rule would fix
      // that cell too and mask a ladder match that never fired. `mid` and
      // `cheap` are what only a whole-lineup re-seed moves — a mutation making
      // `matchesDerivedLadder` always return false survived until these were
      // asserted.
      expect(ladder.premium.model).toBe(m.DEFAULT_TIERS.anthropic.premium);
      expect(ladder.mid.model).toBe(m.DEFAULT_TIERS.anthropic.mid);
      expect(ladder.cheap.model).toBe(m.DEFAULT_TIERS.anthropic.cheap);
      const report = m.consumeLineupRepairReport();
      expect(report?.ids).toContain('anthropic');
      expect(report?.dead).toContain('anthropic:claude-opus-4');
    });

    // The latch. Without it a swallowed write failure means repair re-detects
    // and retries a temp-write + rename on every `loadLineups()` — which is once
    // per `resolveSiteModel`, i.e. dozens of times per turn.
    it('does not retry after a failed write within one process', async () => {
      const m = await loadModule();
      const { LINEUPS_PATH } = await import('./paths.js');
      await writeLineups({
        anthropic: {
          id: 'anthropic',
          name: 'Anthropic-only',
          roles: await legacySeed('anthropic'),
          ...stamp,
        },
      });
      const dir = path.dirname(LINEUPS_PATH);
      fs.chmodSync(dir, 0o555);
      try {
        m.loadLineups();
        expect(m.consumeLineupRepairReport()).not.toBeNull();
        // The write failed, so the file on disk is still the broken seed and a
        // second read re-detects it. Only the latch stops a second attempt.
        m.loadLineups();
        expect(m.consumeLineupRepairReport()).toBeNull();
      } finally {
        fs.chmodSync(dir, 0o755);
      }
    });

    // Across a fresh module load, i.e. what a second `bernard` process sees.
    // Within one process the `repairAttempted` latch alone would make this pass,
    // which would prove nothing about the repair being idempotent.
    it('does nothing on a second process once repaired', async () => {
      const first = await loadModule();
      await writeLineups({
        anthropic: {
          id: 'anthropic',
          name: 'Anthropic-only',
          roles: await legacySeed('anthropic'),
          ...stamp,
        },
      });
      first.loadLineups();
      expect(first.consumeLineupRepairReport()).not.toBeNull();

      const second = await loadModule();
      second.loadLineups();
      expect(second.consumeLineupRepairReport()).toBeNull();
    });

    // A rename is cosmetic, so it must neither block the repair (the lineup is
    // still broken) nor cost the user their label.
    it('repairs a renamed lineup and keeps its name and createdAt', async () => {
      const m = await loadModule();
      await writeLineups({
        anthropic: {
          id: 'anthropic',
          name: 'Work',
          roles: await legacySeed('anthropic'),
          ...stamp,
        },
      });
      const lineups = m.loadLineups();
      expect(lineups.anthropic.name).toBe('Work');
      expect(lineups.anthropic.createdAt).toBe(stamp.createdAt);
      expect(lineups.anthropic.roles.orchestrator.premium.model).toBe(
        m.DEFAULT_TIERS.anthropic.premium,
      );
    });

    // Isolates the ladder-match rule: this lineup holds no dead id, so rule 2
    // cannot fire and only the content match is under test. (An earlier draft
    // used a legacy Anthropic ladder with one cell changed and failed, because
    // `claude-opus-4` was still in it and rule 2 correctly repaired it — the
    // test was wrong, not the code.)
    it('leaves the lineup alone once any single slot differs', async () => {
      const m = await loadModule();
      const roles = fullRoles({
        premium: { provider: 'anthropic', model: 'claude-opus-4-6' },
        mid: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        cheap: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      });
      await writeLineups({
        anthropic: { id: 'anthropic', name: 'Anthropic-only', roles, ...stamp },
      });
      const lineups = m.loadLineups();
      expect(lineups.anthropic.roles.orchestrator.premium.model).toBe('claude-opus-4-6');
      expect(m.consumeLineupRepairReport()).toBeNull();
    });

    // The case a `createdAt === updatedAt` heuristic would have destroyed:
    // `saveLineup` writes one clock read to both fields, so every newly created
    // user lineup looks "untouched".
    it('leaves a user-created lineup that reuses a built-in id alone', async () => {
      const m = await loadModule();
      await writeLineups({
        anthropic: {
          id: 'anthropic',
          name: 'My own',
          roles: fullRoles({
            premium: { provider: 'anthropic', model: 'claude-opus-4-6' },
            mid: { provider: 'openai', model: 'gpt-4.1' },
            cheap: { provider: 'xai', model: 'grok-3-mini' },
          }),
          ...stamp,
        },
      });
      const lineups = m.loadLineups();
      expect(lineups.anthropic.roles.orchestrator.mid.model).toBe('gpt-4.1');
      expect(m.consumeLineupRepairReport()).toBeNull();
    });

    // The belt-and-braces rule, for an install seeded against an older gateway
    // snapshot whose ladder today's derivation no longer reproduces. Only the
    // dead slot moves; the user's other picks stay.
    it('replaces a known-dead model even when the ladder no longer matches', async () => {
      const m = await loadModule();
      const roles = fullRoles({
        premium: { provider: 'anthropic', model: 'claude-opus-4' },
        mid: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        cheap: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      });
      await writeLineups({
        anthropic: { id: 'anthropic', name: 'Anthropic-only', roles, ...stamp },
      });
      const lineups = m.loadLineups();
      expect(lineups.anthropic.roles.orchestrator.premium.model).toBe(
        m.DEFAULT_TIERS.anthropic.premium,
      );
      expect(lineups.anthropic.roles.orchestrator.mid.model).toBe('claude-sonnet-4-6');
      expect(m.consumeLineupRepairReport()?.dead).toEqual(['anthropic:claude-opus-4']);
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
