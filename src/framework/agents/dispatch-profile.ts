import type { AgentContext } from '../context.js';
import { debugLog } from '../../logger.js';
import type { AgentDefinition } from './types.js';

/**
 * How a dispatch is executed, as the record that names it can declare (#508).
 *
 * The audit's central finding is that `AgentDefinition` is already the target
 * runtime and a `Specialist` can address **4 of its ~20 fields** — prompt,
 * model, tools, and a boolean about the result envelope. Everything else about
 * how a specialist runs is a constant chosen by whichever definition happens to
 * dispatch it: every specialist gets `0.5 × maxSteps`, nothing can opt into
 * ReAct, and the only tool-surface exception in the tree is `tool-wrapper`'s
 * hardcoded one.
 *
 * This is the first rung. Three fields, chosen because each has an existing
 * resolution point in `runDefinition` and needs no new machinery;
 * `memoryScope`, `knowledgeScope`, `delegates`, posture and `outputSchema` stay
 * out until there is an enforcer to honour them (#501, #505, #511) — a
 * declarable field with nothing enforcing it is a lie on disk.
 *
 * ## The four properties, copied from `RoleId`
 *
 * `role` + `resolveSiteModel` is the best-designed declarative layer in the
 * tree, and #508 asks that every field added here follow all four of its
 * properties, not just the shape:
 *
 * 1. **The record declares intent, not a binding.** `stepRatio` is a fraction of
 *    `config.maxSteps`, never an absolute count — an absolute would fight
 *    `BERNARD_MAX_STEPS` and go stale the moment the user changed it, exactly as
 *    a `provider`/`model` pin goes stale against a lineup.
 * 2. **The runtime resolves it per dispatch**, against live config, and keeps
 *    resolving correctly when that config changes.
 * 3. **Validated, not trusted.** Every value comes off a user-editable JSON
 *    file. An unknown one logs and falls back rather than throwing, the
 *    `model-policy.ts` `isKnownMode` / unknown-role idiom verbatim — this
 *    function runs on every dispatch, so a throw here is a broken record taking
 *    down every turn that touches it.
 * 4. **Provenance is recorded.** A resolution that silently differs from the
 *    default is exactly the thing nobody can debug from behaviour alone.
 *
 * ## Why it resolves here rather than inside the definitions
 *
 * #508 requires it — "resolution must live in `runDefinition`, not the dispatch
 * tools" — and the signatures make it the only option anyway:
 * `def.stepBudget(config, input)` receives no `ctx`, so it cannot reach a store,
 * and `resolveToolSurface(ctx, def)` receives no `input`, so it cannot know
 * *which* record. It joins `resolveToolSurface` and `resolveRetrieval` in the
 * same slot for the same reason those two are there: a cross-cutting fact about
 * what a dispatch is entitled to, decided once, with the definitions as
 * consumers of the answer rather than N copies of the rule.
 */

/** Execution strategies a record may ask for. Mirrors `PolicyDecision['strategyId']`. */
export const DISPATCH_STRATEGIES = ['normal', 'react'] as const;
export type DispatchStrategy = (typeof DISPATCH_STRATEGIES)[number];

/** Tool surfaces a record may ask for. Mirrors `AgentDefinition.toolSurface`. */
export const DISPATCH_TOOL_SURFACES = ['full', 'worker'] as const;
export type DispatchToolSurface = (typeof DISPATCH_TOOL_SURFACES)[number];

/**
 * Upper bound on a declared `stepRatio`.
 *
 * Not a safety limit — `config.maxSteps` is the real budget and a specialist is
 * already free to burn all of it — but a typo guard. `stepRatio: 50` reads as
 * "fifty steps" and would mint 50 × `maxSteps`, which is a runaway dispatch
 * rather than a declaration. 2 leaves room for a specialist that genuinely
 * needs more room than the site default while making a mis-read unit obvious.
 */
export const MAX_STEP_RATIO = 2;

/** What the record asked for, after validation. Absent fields keep the definition's own answer. */
export interface DispatchProfile {
  stepRatio?: number;
  strategy?: DispatchStrategy;
  toolSurface?: DispatchToolSurface;
}

/** Empty profile, shared so the common path allocates nothing. */
const NONE: DispatchProfile = Object.freeze({});

function known<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/**
 * A record's declared tool surface, validated — or `undefined` when it declared
 * none or declared nonsense.
 *
 * Exported because `dispatchToolWrapper` assembles its `childTools` **before**
 * `runDefinition` runs, so it cannot take the resolved profile. It reads the
 * record itself, and it must reach the same verdict this module does: two
 * readers of one field, one definition of what a valid value is. Without it a
 * wrapper record declaring `toolSurface: 'everythin'` would be honoured at the
 * assembly and rejected by the runner, which is the worst of both.
 */
export function declaredToolSurface(record: {
  toolSurface?: unknown;
}): DispatchToolSurface | undefined {
  return known(DISPATCH_TOOL_SURFACES, record.toolSurface) ? record.toolSurface : undefined;
}

/**
 * Reads the record a dispatch names, if it names one, and returns the execution
 * fields it validly declares.
 *
 * Never throws and never returns `undefined`: a missing store, a missing
 * record, a corrupt field or a store that throws on read all yield the empty
 * profile, which is byte-for-byte today's behaviour. That matters more than it
 * looks — this runs before every dispatch in the process, `main` included.
 */
export function resolveDispatchProfile<TInput>(
  ctx: AgentContext,
  def: Pick<AgentDefinition<TInput, unknown>, 'id' | 'recordId'>,
  input: TInput,
): DispatchProfile {
  if (!def.recordId) return NONE;
  const id = def.recordId(input);
  if (!id) return NONE;

  let record;
  try {
    record = ctx.stores.specialists?.get(id);
  } catch {
    return NONE;
  }
  if (!record) return NONE;

  const profile: DispatchProfile = {};
  const rejected: Record<string, unknown> = {};

  const { stepRatio, strategy, toolSurface } = record;
  if (stepRatio !== undefined) {
    if (
      typeof stepRatio === 'number' &&
      Number.isFinite(stepRatio) &&
      stepRatio > 0 &&
      stepRatio <= MAX_STEP_RATIO
    ) {
      profile.stepRatio = stepRatio;
    } else {
      rejected.stepRatio = stepRatio;
    }
  }
  if (strategy !== undefined) {
    if (known(DISPATCH_STRATEGIES, strategy)) profile.strategy = strategy;
    else rejected.strategy = strategy;
  }
  if (toolSurface !== undefined) {
    const valid = declaredToolSurface(record);
    if (valid) profile.toolSurface = valid;
    else rejected.toolSurface = toolSurface;
  }

  // Two lines, not one, and for the reason `model-policy.ts` splits its own:
  // "this record declared something invalid" is a bug report about a file on
  // disk, while "this record is running differently from the site default" is
  // the provenance an operator reads to explain a step count. Folding them
  // makes the first invisible in the noise of the second.
  if (Object.keys(rejected).length > 0) {
    debugLog('dispatch-profile:invalid', { definition: def.id, specialistId: id, ...rejected });
  }
  if (Object.keys(profile).length > 0) {
    debugLog('dispatch-profile:resolved', { definition: def.id, specialistId: id, ...profile });
    return profile;
  }
  return NONE;
}
