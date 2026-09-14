import { describe, it, expect } from 'vitest';
import { deriveTiers } from './tiers.js';
import { getCatalogForProvider, type ModelCatalogEntry } from './catalog.js';

/**
 * `deriveTiers` no longer produces a seed — since #447 that is the curated
 * `DEFAULT_TIERS` in `src/lineups.ts`. It survives as the *recogniser*
 * `repairBuiltinLineups` uses to decide whether a stored lineup is an untouched
 * machine seed from before the fix.
 *
 * That inverts what its tests are for. These do not assert that the ranking is
 * a good way to choose models — it is not, which is why it was replaced. They
 * assert it still reproduces what the old seeder wrote, because the moment it
 * stops, repair silently stops recognising the installs it exists to repair.
 */
function entry(model: string, outputPerMTok: number, released = 0): ModelCatalogEntry {
  return {
    provider: 'anthropic',
    model,
    displayName: model,
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    tags: [],
    pricing: { inputPerMTok: 0, outputPerMTok },
    released,
  };
}

describe('deriveTiers', () => {
  it('throws on an empty catalog rather than inventing a ladder', () => {
    expect(() => deriveTiers([])).toThrow(/empty catalog/i);
  });

  it('collapses all three tiers onto a lone entry', () => {
    expect(deriveTiers([entry('only', 5)])).toEqual({
      premium: 'only',
      mid: 'only',
      cheap: 'only',
    });
  });

  it('gives two entries the dearer as premium and mid', () => {
    expect(deriveTiers([entry('cheap', 1), entry('dear', 9)])).toEqual({
      premium: 'dear',
      mid: 'dear',
      cheap: 'cheap',
    });
  });

  it('takes the price extremes and the median', () => {
    const tiers = deriveTiers([entry('a', 1), entry('b', 5), entry('c', 9), entry('d', 7)]);
    expect(tiers).toEqual({ premium: 'c', mid: 'b', cheap: 'a' });
  });

  it('breaks a price tie by recency, newest first', () => {
    const tiers = deriveTiers([entry('old', 9, 100), entry('new', 9, 200), entry('floor', 1)]);
    expect(tiers.premium).toBe('new');
  });

  /**
   * The bug itself, pinned. `claude-opus-4` is retired and its catalog entry
   * still carries the legacy $75/MTok output price — the highest of any
   * Anthropic entry, where every current Opus is $25 — so it wins `premium`
   * precisely *because* it was retired and its price was never cut.
   *
   * If this ever stops holding, the shipped catalog has moved and
   * `repairBuiltinLineups` can no longer recognise an Anthropic install seeded
   * before #447. That is a real loss of coverage, not a stale test: fix it by
   * adding the id to `DEAD_SEEDED_MODELS`, not by deleting the case.
   */
  it('still reproduces the pre-#447 Anthropic seed from the shipped catalog', () => {
    const entries = getCatalogForProvider('anthropic');
    expect(entries.length).toBeGreaterThan(0);
    expect(deriveTiers(entries).premium).toBe('claude-opus-4');
  });
});
