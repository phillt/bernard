/**
 * What a model mode IS, and how it is worded (#170/#225/#606).
 *
 * A zero-import leaf — the type, the predicate, the legacy migration, the
 * startup notice that migration owes the user, and the rows every surface asks
 * the question from. It imports nothing, which is what makes it reachable from
 * both sides of a cycle: `profiles.ts` (the persisted shape) and `config.ts`
 * (the read boundary) are separated by `model-policy.ts` → `config.ts` →
 * `profiles.ts`, so a predicate living in `model-policy.ts` is one
 * `profiles.ts` cannot import — and duly re-spelled by hand, twice.
 *
 * ## Four hand-written copies of a three-member list, one of them a screen
 *
 * `ModelMode` lost its `'off'` member when #225 moved tiering onto user-defined
 * lineups. `/agent-options` dropped the row; the setup wizard did not, and the
 * field's description still ended "off ignores the lineup". So the row stayed on
 * screen and the value it produced was not refused — {@link
 * normalizeStoredModelMode} MIGRATED it to `'optimize-performance'`, sending
 * every call site to the premium slot. The most expensive setting in the
 * product, reached by the row that reads as opting out, silently. #582 then
 * marked that field `tier: 'quick'`, which made it one of the three questions a
 * first run asks.
 *
 * There were FIVE hand-written copies of the list behind that, and the screen was
 * only the loudest: `isKnownMode`; `normalizeStoredModelMode`'s own inline list
 * four lines below it; `config.ts`'s `isModelMode`, which had no caller at all;
 * and two in `profiles.ts` — `ProfileSettings.modelMode` re-declaring the union
 * rather than naming the type (the more durable, since it is the type the
 * WIZARD writes, so the persisted shape and the runtime type could diverge with
 * no error), and a SECOND `'off'` migration in `readLegacyPreferences`, whose
 * hand-rolled enumeration silently DROPPED anything it did not list for want of
 * an `else`. All five are gone; this file is what they collapsed into.
 *
 * ## The capability `'off'` named is still reachable
 *
 * It meant "every site on one model", and a lineup whose slots all name the same
 * model produces exactly that under any mode. That is what makes removing it
 * from the settings rows a removal rather than a capability loss, so it is
 * measured rather than asserted: `model-policy.test.ts` → "a lineup with one
 * model in every slot" resolves every site under every mode and requires
 * `source: 'policy'`.
 *
 * What is NOT equivalent is the affordance. Binding one model everywhere is 18
 * slots (6 roles × 3 tiers) through `/lineup`, one role at a time, with no
 * "apply to all" row — where `'off'` was one keystroke. The rows below cannot
 * close that, and the wizard's own description is what stops a first-run reader
 * losing the thread: the clause that went ("off ignores the lineup") was the
 * only place that walk said the word LINEUP out loud, so the replacement names
 * `/lineup` and says every rung can be bound to the same model. The editor
 * affordance itself is #618.
 *
 * ## The rows are shared and the framing is not
 *
 * Only the ROWS are shared. The sentence that introduces them is per surface,
 * because the budgets differ: the wizard's description is the only explanation
 * on a screen someone meets on their first run, while the menu's parent row is a
 * one-line teaser in front of a submenu whose rows carry their own
 * `description`.
 */

/**
 * Three-value runtime mode. The legacy `'off'` value is gone — every active call
 * site now flows through the active lineup.
 */
export type ModelMode = 'optimize-tokens' | 'balanced' | 'optimize-performance';

/** True when `mode` is a recognized {@link ModelMode}. */
export function isKnownMode(mode: unknown): mode is ModelMode {
  return mode === 'optimize-tokens' || mode === 'balanced' || mode === 'optimize-performance';
}

/** The retired mode, still on disk and in shell profiles. Matched, never offered. */
export const LEGACY_MODE = 'off';

/**
 * Normalizes any modelMode-shaped value read from disk or env. Returns the
 * canonical runtime mode, or `undefined` for inputs that don't match. Migrates
 * legacy `'off'` → `'optimize-performance'`.
 *
 * **The migration stays even though the row is gone (#606), and the two are not
 * the same decision.** `'off'` is still on disk for anyone who chose it before
 * #225 — and, since #582 put that field on the quick path, for anyone whose
 * first run picked the broken row weeks ago. The two populations are
 * indistinguishable on disk, which is a reason not to guess between them.
 *
 * **Why `'optimize-performance'` and not the default**, stated correctly this
 * time: an earlier version of this comment argued that refusing `'off'` would
 * "re-tier them silently", which is true of migrating them too and is therefore
 * no argument at all — `DEFAULT_MODEL_MODE` is `balanced`, so refusing would
 * land them somewhere CHEAPER than this does. What actually decides it is
 * shape: `'off'` meant one model for every site, and one tier everywhere is
 * closer to that than a ladder is.
 *
 * It remains a best-effort READ of an old preference rather than a faithful one
 * — `'off'` meant `config.model` everywhere, while this lands on the active
 * lineup's premium slot, the same model only when the lineup is the seeded one
 * for that provider. Best effort is the right posture for a value already
 * written and the wrong one for a row somebody is picking now with the label in
 * front of them, which is what the wizard was doing with it.
 *
 * Which leaves the third case, and it is the one that reads as a stored
 * preference and is not: `BERNARD_MODEL_MODE=off` exported in a shell profile is
 * RE-PICKED at every launch, from a surface with no label in front of it at all.
 * The migration cannot be dropped for it either — the remedy is to say so, which
 * is {@link legacyModelModeNotice}.
 */
export function normalizeStoredModelMode(v: unknown): ModelMode | undefined {
  if (isKnownMode(v)) return v;
  if (v === LEGACY_MODE) return 'optimize-performance';
  return undefined;
}

/**
 * What to tell the user at startup when a legacy `'off'` is still being read.
 *
 * Pure over the RAW values, in the `cost-guardrail.ts` / `catalog-notice.ts`
 * shape: no latch inside the normalizer, because both sources are readable
 * unparsed at the one call site that renders this — `process.env` directly, and
 * the active profile's settings blob, which `loadProfiles` casts rather than
 * validates (`config.ts`'s `parseSettings` is where normalization happens, one
 * layer up).
 *
 * The env case is where the fix is cheapest and complete: the value is
 * re-supplied every run, so saying it once per start is the whole remedy and
 * nothing needs migrating. The stored case repeats until the user re-picks,
 * which is correct — the setting really is wrong until then, and `/agent-options`
 * shows `optimize-performance` rather than the `off` they believe they chose.
 *
 * Deliberately does NOT claim the migrated value is in force: `prefs.modelMode
 * ?? envModelMode` means a stored answer beats an exported one, so a session can
 * carry a dead `BERNARD_MODEL_MODE=off` while running `balanced`. Saying "you
 * are on optimize-performance" there would be this PR's own defect — a confident
 * sentence about a setting that is not what it says.
 */
export function legacyModelModeNotice(sources: {
  /** Raw `process.env.BERNARD_MODEL_MODE`. */
  env?: string | undefined;
  /** Raw `modelMode` off the active profile's settings blob. */
  stored?: unknown;
}): string | undefined {
  const fromEnv = sources.env === LEGACY_MODE;
  const fromStored = sources.stored === LEGACY_MODE;
  if (!fromEnv && !fromStored) return undefined;
  // One clause, not a fragment plus a shared tail: composing "…set to" with
  // "model mode \"off\"" read as "set to model mode \"off\"" in every arm.
  const where = fromEnv
    ? fromStored
      ? 'BERNARD_MODEL_MODE and your profile both say model mode "off"'
      : 'BERNARD_MODEL_MODE is set to "off"'
    : 'your profile has model mode "off"';
  const remedy = fromEnv
    ? 'Unset the variable, or pick a mode in /agent-options → Model mode, to choose deliberately.'
    : 'Pick one in /agent-options → Model mode to choose deliberately.';
  return (
    `Heads up — ${where}, which is no longer a model mode. ` +
    `It is being read as "optimize-performance", which sends every model call to your lineup's ` +
    `premium slot — the most expensive setting there is. ${remedy}`
  );
}

/**
 * One row per answer, for every surface that asks.
 *
 * Typed {@link ModelMode} rather than `string`, which is the whole point: a row
 * whose value the runtime does not accept is now a compile error. The type
 * cannot see the other two failures, so `settings-coverage.test.ts` does — a
 * value the union admits but {@link normalizeStoredModelMode} rewrites, a mode
 * the runtime has that nothing offers, and a surface that stopped reading this
 * table at all.
 *
 * Order is default-first: `balanced` leads because it is `DEFAULT_MODEL_MODE`,
 * and the wizard marks it "(recommended)" on that basis.
 *
 * `description` ADDS to whatever framing the surface already shows — what
 * picking the row costs you — and is bounded at 60 characters, the bound
 * `coordinator-modes.test.ts` already pins on this same shape, because the
 * wizard reserves exactly one row for it and truncates rather than wraps. Stated
 * as prose here and pinned in the test: this PR's whole argument is that a rule
 * nothing checks is how a four-row menu ends up in front of a three-value union.
 * The `/agent-options` copy it replaces spent that budget naming role and tier
 * ("Premium orchestrator; mid executor/function-caller/summarizer; cheap
 * classifier"), which is five of our words for our own machinery on a screen a
 * reader meets early; `/lineup` is where the role ladder is legible.
 */
export const MODEL_MODES: ReadonlyArray<{
  value: ModelMode;
  label: string;
  description: string;
}> = [
  {
    value: 'balanced',
    label: 'Balanced',
    description: 'Strong model for your turns, cheaper ones behind.',
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
