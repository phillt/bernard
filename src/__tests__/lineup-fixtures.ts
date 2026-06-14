import { ALL_ROLE_IDS } from '../model-roles.js';

/** Test-only mirrors of the lineup slot shapes (see {@link module:lineups}). */
export type Slot = { provider: string; model: string };
export type Ladder = { premium: Slot; mid: Slot; cheap: Slot };

/**
 * Replicates one cost ladder across all roles — the migration shape a flat
 * (role-less) lineup expands into. Mirrors the production `replicateAcrossRoles`
 * helper, kept here so the store and policy suites share one fixture.
 */
export function fullRoles(ladder: Ladder): Record<string, Ladder> {
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
