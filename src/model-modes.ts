/**
 * How much model each call site gets, and how that is worded (#170/#606).
 *
 * The `coordinator-modes.ts` / `tool-modes.ts` shape, at `src/` root for the
 * reason those record: `profiles-wizard-data.ts` is host-agnostic by contract,
 * so a table under `src/ui/` is one the setup wizard cannot import and therefore
 * one it hand-writes. It already had — the wizard and `/agent-options` each
 * carried their own copy of these rows, plus a third paraphrase on the menu's
 * parent row. All three of that menu's mode questions drifted; the other two are
 * already tables, and this is the one whose drift reached a value the runtime
 * does not have.
 *
 * ## The drift was not cosmetic: one copy offered a mode that does not exist
 *
 * `ModelMode` lost its `'off'` member when #225 moved tiering onto user-defined
 * lineups. `/agent-options` dropped the row; the wizard did not, and the field's
 * description still ended "off ignores the lineup". So the row stayed on screen
 * and the value it produced was not refused — `normalizeStoredModelMode` MIGRATED
 * it to `'optimize-performance'`, sending every site to the premium slot. The
 * most expensive setting in the product, reached by the row that reads as opting
 * out, silently. #582 then marked that field `tier: 'quick'`, which made it one
 * of the three questions a first run asks.
 *
 * **The capability it named is expressible without it**, which is why the row is
 * gone rather than reimplemented: `'off'` meant "every site on one model", and a
 * lineup whose slots all name the same model produces exactly that under any
 * mode. Verified against the resolver rather than asserted — every site resolves
 * to the one model with `source: 'policy'`, pinned by `model-policy.test.ts` →
 * "a lineup with one model in every slot".
 *
 * ## The rows are shared and the framing is not
 *
 * Only the ROWS live here. The sentence that introduces them is per surface,
 * because the budgets differ: the wizard's description is the only explanation
 * on a screen someone meets on their first run, while the menu's parent row is a
 * one-line teaser in front of a submenu whose rows carry their own
 * `description`.
 */

import type { ModelMode } from './model-policy.js';

/**
 * One row per answer, for every surface that asks.
 *
 * Typed `ModelMode` rather than `string`, which is the whole point: a row whose
 * value the runtime does not accept is now a compile error rather than a screen.
 * The type cannot see the other two failures, so `settings-coverage.test.ts`
 * does — a value the union admits but `normalizeStoredModelMode` rewrites, and a
 * mode the runtime has that nothing offers.
 *
 * Order is cheapest-first-after-the-default: `balanced` leads because it is
 * `DEFAULT_MODEL_MODE`, and the wizard marks it "(recommended)" on that basis.
 *
 * `description` ADDS to whatever framing the surface already shows — what
 * picking the row costs you — and is kept under about fifty characters, because
 * the wizard reserves exactly one row for it and truncates rather than wraps.
 * The `/agent-options` copy it replaces spent that budget naming role and tier
 * ("Premium orchestrator; mid executor/function-caller/summarizer; cheap
 * classifier"), which is five of our words for our own machinery on the screen a
 * reader meets first; `/lineup` is where the role ladder is legible.
 */
export const MODEL_MODES: ReadonlyArray<{
  value: ModelMode;
  label: string;
  description: string;
}> = [
  {
    value: 'balanced',
    label: 'Balanced',
    description: 'The strong model for your turns, cheaper ones behind.',
  },
  {
    value: 'optimize-tokens',
    label: 'Optimize for token usage',
    description: 'Moves your own turns down a tier as well.',
  },
  {
    value: 'optimize-performance',
    label: 'Optimize for performance',
    description: 'The strong model everywhere, at its price.',
  },
];
