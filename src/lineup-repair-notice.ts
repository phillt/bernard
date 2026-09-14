/**
 * Telling the user that a seeded lineup was rewritten under them (#447).
 *
 * Seeding used to derive tier models by ranking the Vercel AI Gateway catalog by
 * output price, which picked ids the direct provider does not serve —
 * `claude-opus-4` most visibly, retired and still listing its legacy $75/MTok
 * price. `repairBuiltinLineups` rewrites those, which means a user starts a
 * session and their model selection has silently changed. That has to be said
 * out loud: it is a change they did not ask for, to the setting that decides
 * what everything costs.
 *
 * A pure decision module in the `memory-notice.ts` / `cost-guardrail.ts` shape,
 * for the same reason those are: the caller owns the surfacing, so what is worth
 * saying is testable without a terminal. That matters more here than usual —
 * this is the one message whose whole job is to explain an unrequested change,
 * and composed inline in `runInkRepl` it had no test at all.
 */

import { nameList, plural } from './text.js';
import type { LineupRepairReport } from './lineups.js';

/** Enough to recognise what happened without pasting a wall of model ids. */
const IDS_NAMED = 3;

/**
 * Returns a user-facing notice for a repair that happened, or `null` when none
 * did.
 *
 * **Separates "refreshed" from "could not be used", and that distinction is the
 * point.** A ladder match re-seeds the whole lineup, so most of what it replaces
 * was working fine; an earlier draft listed every replaced id under a sentence
 * about models that do not work, which named `grok-4.6` as broken. `dead` is
 * only ever the subset measured not to dispatch, and an empty `dead` is the
 * normal case — it means "this was an old machine seed, now refreshed".
 */
export function lineupRepairNotice(report: LineupRepairReport | null): string | null {
  if (!report || report.ids.length === 0) return null;
  const n = report.ids.length;
  const d = report.dead.length;
  const couldNotBeUsed =
    d > 0
      ? ` ${d} of ${plural(n, 'them', 'those')} could not be used at all: ${nameList(report.dead)}.`
      : '';
  return (
    `Heads up — your default model ${plural(n, 'lineup', 'lineups')} ` +
    `(${nameList(report.ids, IDS_NAMED)}) ${plural(n, 'was', 'were')} set up by an older ` +
    `version of Bernard that picked models automatically, so I've refreshed ` +
    `${plural(n, 'it', 'them')}.${couldNotBeUsed} Use /lineup to change any of it.`
  );
}
