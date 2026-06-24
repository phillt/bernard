/**
 * @module providers/tiers
 *
 * Derive the three lineup tiers (`premium`, `mid`, `cheap`) from a list of
 * catalog entries for a single provider, using output-price quantiles with a
 * recency tie-break.
 *
 * Used by `seedDefaultLineups()` when a fresh install (or a built-in provider
 * with no existing lineup) needs sensible defaults — the user can still
 * override any slot through the `/models` lineup editor.
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
