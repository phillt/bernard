/**
 * @module providers/tiers
 *
 * Derive three lineup tiers (`premium`, `mid`, `cheap`) from a single
 * provider's catalog entries, by output-price quantile with a recency
 * tie-break.
 *
 * **This no longer PRODUCES a seed. It only RECOGNISES one.** Until #447 this
 * was what `seedForProvider` used, and ranking a *gateway* catalog by price is
 * unsound as a way to choose ids for a *direct* provider SDK: price extremes are
 * where non-servable models live. It seeded Anthropic's premium as
 * `claude-opus-4` — retired, still listing its legacy $75/MTok price, therefore
 * top of the sort, and not dispatchable. Seeding now comes from the curated
 * `DEFAULT_TIERS` in `src/lineups.ts`; the full argument lives there.
 *
 * What survives is the one thing this function is still good at: reproducing
 * exactly what the old seeder wrote. `repairBuiltinLineups` compares a stored
 * lineup against this output to decide whether it is an untouched machine seed
 * that may be safely rewritten. So do not "fix" the ranking — a change here does
 * not improve any default, it only makes repair stop recognising the installs it
 * exists to repair.
 */

import type { ModelCatalogEntry } from './catalog.js';

export interface DerivedTiers {
  premium: string;
  mid: string;
  cheap: string;
}

/**
 * Sort entries by output price descending; tie-break by `released` descending
 * (newer first) so when two models cost the same we prefer the more recent
 * release.
 */
function sortByPriceDescThenRecency(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return [...entries].sort((a, b) => {
    if (b.pricing.outputPerMTok !== a.pricing.outputPerMTok) {
      return b.pricing.outputPerMTok - a.pricing.outputPerMTok;
    }
    return b.released - a.released;
  });
}

/**
 * Picks `premium`, `mid`, `cheap` from a single provider's catalog entries.
 *
 *   - Top entry by output price → `premium`.
 *   - Bottom entry → `cheap`.
 *   - Median entry → `mid` (for even counts we take the lower-priced of the
 *     two middle slots, since the array is sorted descending — i.e.
 *     `sorted[Math.floor(n/2)]`).
 *   - One entry collapses all three slots.
 *   - Two entries: `premium = mid = sorted[0]`, `cheap = sorted[1]`.
 *
 * @throws when `entries` is empty.
 */
export function deriveTiers(entries: ModelCatalogEntry[]): DerivedTiers {
  if (entries.length === 0) {
    throw new Error('deriveTiers: cannot derive tiers from an empty catalog.');
  }
  const sorted = sortByPriceDescThenRecency(entries);
  if (sorted.length === 1) {
    const only = sorted[0]!.model;
    return { premium: only, mid: only, cheap: only };
  }
  if (sorted.length === 2) {
    return {
      premium: sorted[0]!.model,
      mid: sorted[0]!.model,
      cheap: sorted[1]!.model,
    };
  }
  const premium = sorted[0]!.model;
  const cheap = sorted[sorted.length - 1]!.model;
  const mid = sorted[Math.floor(sorted.length / 2)]!.model;
  return { premium, mid, cheap };
}
