import type { AgentContext } from '../context.js';
import { debugLog } from '../../logger.js';
import type { AgentDefinition } from './types.js';
import { isValidLibraryId } from '../../knowledge/ids.js';
import { isValidScopePattern } from '../../memory.js';
import { getDomainIds } from '../../domains.js';

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

/**
 * What the record asked for, after validation. Absent fields keep the
 * definition's own answer.
 *
 * The three knowledge fences are declared here as ordinary optional members,
 * and {@link ScopeField} is derived FROM them — they are the only `string[]`
 * members, which separates them structurally from `stepRatio` / `strategy` /
 * `toolSurface`.
 */
export interface DispatchProfile {
  stepRatio?: number;
  strategy?: DispatchStrategy;
  toolSurface?: DispatchToolSurface;
  /**
   * The knowledge fences. One field per store, and each is described by its
   * entry in {@link SCOPE_AXES} rather than here — everything downstream reads
   * the table, so a rationale written beside the declaration is one nobody
   * arrives at. Absent means unscoped; `[]` means deny-all.
   */
  memoryScope?: string[];
  knowledgeScope?: string[];
  corpusScope?: string[];
}

/**
 * The scope fields of a {@link DispatchProfile}, DERIVED rather than re-listed
 * (#552).
 *
 * Adding a fourth axis used to mean eleven touch points, nine of them
 * character-for-character uniform — and the first attempt missed two, both
 * silently. This is what turns both directions of that mistake into compile
 * errors: `AXES` is `satisfies Record<ScopeField, ScopeAxisSpec>`, so an axis
 * on the profile with no table entry fails to typecheck (`TS1360`), and a table
 * key that is not a profile field is rejected (`TS2353`). A runtime list would
 * re-encode the same three names by hand, which is the thing being removed.
 *
 * `-?` strips the optionality so `string[] | undefined` does not swallow every
 * member; `string[] extends T` (rather than the other way round) admits exactly
 * the `string[]` members and rejects `number` and the two string unions.
 *
 * **The inverse — `ScopeField = keyof typeof AXES`, with the profile extending
 * it — was tried and is weaker.** It makes both mistakes unrepresentable rather
 * than checked, which sounds stronger and is not: deleting a table entry then
 * silently deletes the field from `Specialist`, `CronJob` and
 * `DispatchContextRecord`, so every record already on disk carrying that fence
 * is ignored, with `tsc` clean. This direction reports it as `TS1360`. The
 * objection that motivated the inversion — that a future non-fence `string[]`
 * member (`delegates`, reserved above for #501) would silently become an axis —
 * was checked and is false: it lands in `ScopeField`, `AXES` no longer
 * satisfies the record, and the build fails until someone decides.
 */
export type ScopeField = {
  [K in keyof DispatchProfile]-?: string[] extends DispatchProfile[K] ? K : never;
}[keyof DispatchProfile];

/** Just the fences — what a caller declares, and what a record reports it ran under. */
export type ScopeSelection = Pick<DispatchProfile, ScopeField>;

/**
 * Anything that narrows itself to a subset and returns the same kind.
 *
 * Structural on purpose: `MemoryStore`, `RAGStore` and `KnowledgeCorpus` all
 * satisfy it, and naming them here would give this module — which runs before
 * every dispatch in the process, `main` included — a runtime edge to three
 * stores it never constructs.
 */
export interface Narrowing<T> {
  scoped(scope: readonly string[] | null | undefined): T;
}

/**
 * One fence: the field, how to say it, how to check it, and where to apply it.
 *
 * The table replaces nine uniform touch points. The two that are NOT uniform
 * are the reason `apply` is a function rather than a store name, and the reason
 * `standalone` exists — see each below.
 */
interface ScopeAxisSpec {
  /**
   * Short name for a surface that has already said "Scoped to:".
   *
   * Deliberately not unified with the field name: `specialist inspect` prints
   * `memoryScope` and the dispatch-context viewer prints `memory`, both are
   * user-visible, and collapsing them would change output for no gain. The
   * entry carries both vocabularies rather than picking one.
   */
  readonly label: string;
  /**
   * Whether one declared entry is well-formed — a THUNK, not a predicate.
   *
   * `knowledgeScope`'s check is an existence test against the domain registry
   * and closes over a `Set` that must be built when validation runs, not when
   * this module loads. The other two are stateless module-level functions and
   * ignore the extra call.
   */
  readonly validate: () => (value: unknown) => boolean;
  /**
   * Narrows the one store this axis fences, on a context.
   *
   * A function per axis rather than declarative data, because the three arms
   * genuinely reach different places: `memoryScope` is nested one level and
   * rebuilds `{ ...ctx.stores, memory }`, while the other two are flat optional
   * chains on `ctx.rag` and `ctx.knowledge`. Each arm is applied only when its
   * own field is declared, which is what preserves `ctx.stores` IDENTITY for a
   * fence that does not touch memory.
   */
  readonly apply: (ctx: AgentContext, value: string[]) => AgentContext;
  /**
   * Which store this fence must ALSO be applied to outside a context, when it
   * has such a point. Populated by exactly one axis today.
   *
   * `headless.ts` starts its RAG search BEFORE `assembleContext`, deliberately,
   * to overlap the ~1.1-1.6 s MCP connect, so that one retrieval is the single
   * thing a ctx-level fence cannot reach. So `memoryScope` has one application
   * point, `knowledgeScope` has two, and `corpusScope` has one plus a standing
   * comment in `headless.ts` forbidding a second. Modelled here so the
   * asymmetry is a property of the table rather than a fact you have to know.
   *
   * It names the STORE rather than being a boolean, and that is what makes
   * {@link applyStandaloneScopes} safe: the helper takes the same store kind,
   * so a future axis whose second application point is a different store is
   * *correctly* not applied to this one, instead of being silently swept into
   * a call that would fence the wrong store with the wrong vocabulary.
   */
  readonly standalone?: StandaloneStore;
}

/** Stores a fence can be applied to outside a context. One today. */
export type StandaloneStore = 'rag';

/** One entry of {@link SCOPE_AXES}: its spec, plus the key it was declared under. */
export interface ScopeAxis extends ScopeAxisSpec {
  /** The field, on the profile and on every record that can declare one. */
  readonly field: ScopeField;
}

/**
 * The three fences, in the order every surface renders them — and the SOURCE of
 * what a scope axis is (#552).
 *
 * Every consumer iterates this rather than naming an axis, so the #550 mistake
 * — a surface that knows about two axes when there are three — has one place
 * left to be made, and {@link ScopeField} makes that place a compile error in
 * both directions.
 *
 * Entries do not repeat their own key: `field` is attached when the table is
 * flattened, which removes the one thing in the first draft that could disagree
 * with itself.
 */
const AXES = {
  memoryScope: {
    label: 'memory',
    // Matches the SANITIZED key, which is the correctness argument rather than
    // a convenience: `MemoryStore` repairs names rather than rejecting them, so
    // `"pro j-secret"` and `"proj-secret"` address one file and must get one
    // verdict. The pattern language is deliberately tiny — an exact key, or a
    // prefix ending in `*` — because a fence written in a language is one
    // nobody can read at a glance.
    validate: () => isValidScopePattern,
    apply: (ctx, value) => ({
      ...ctx,
      stores: { ...ctx.stores, memory: ctx.stores.memory.scoped(value) },
    }),
  },
  knowledgeScope: {
    label: 'knowledge',
    // The existing RAG `domain` axis — no new field, no migration, no
    // re-embedding: every record is already labelled and `scoreAndRank` already
    // groups by domain, so a scoped search is the same ranking over a smaller
    // corpus rather than a truncated result.
    validate: () => {
      const known = new Set(getDomainIds());
      return (v: unknown) => typeof v === 'string' && known.has(v);
    },
    apply: (ctx, value) => ({ ...ctx, rag: ctx.rag?.scoped(value) }),
    standalone: 'rag',
  },
  corpusScope: {
    label: 'corpus',
    // Shape, never existence, and that is what makes this a separate field from
    // `knowledgeScope` rather than a reuse of it. That axis's predicate asks
    // whether a DOMAIN exists, so a library name in it resolves to `[]` —
    // silent deny-all. `isValidLibraryId` is a zero-import leaf precisely so
    // this predicate cannot touch disk or throw, and a well-formed id naming a
    // library nobody has created yet is KEPT: it already fails closed by
    // matching nothing. Memory and knowledge were already two fields for two
    // stores; a third store gets a third.
    validate: () => isValidLibraryId,
    apply: (ctx, value) => ({ ...ctx, knowledge: ctx.knowledge?.scoped(value) }),
  },
} as const satisfies Record<ScopeField, ScopeAxisSpec>;

export const SCOPE_AXES: readonly ScopeAxis[] = Object.entries(AXES).map(([field, spec]) => ({
  // The one cast in this module: `Object.entries` widens the key to `string`,
  // and it is `keyof typeof AXES` by construction.
  field: field as ScopeField,
  ...spec,
}));

/**
 * The fences of anything that carries them, as a `ScopeSelection`.
 *
 * One consumer — the dispatch-context record — but written over the table for
 * the reason every other surface is: three conditional spreads naming the axes
 * by hand is the exact shape that shipped one axis short (#550).
 *
 * Only an ABSENT axis is dropped. `[]` is a real posture — deny-all — and is
 * recorded as one, which is also what the conditional spreads this replaces
 * did, since `[]` is truthy. Dropping it would make "fenced to nothing" and
 * "not fenced" render identically on the one surface that exists to tell a
 * fence apart from a bad retrieval.
 */
export function pickScopes(from: ScopeSelection): ScopeSelection {
  const out: ScopeSelection = {};
  for (const axis of SCOPE_AXES) {
    const value = from[axis.field];
    if (value) out[axis.field] = value;
  }
  return out;
}

/**
 * Applies every axis with a ctx-free application point to a store that narrows
 * itself.
 *
 * One consumer today — `headless.ts`'s pre-connect RAG search — and it exists
 * so that consumer names the CAPABILITY rather than the axis. A fourth fence
 * that also had to be applied before context assembly would then be a table
 * edit, which is the whole point of #552; hard-coding `.scoped(scope
 * .knowledgeScope)` there is the tenth touch point.
 *
 * `kind` is required rather than implied, because the set this iterates has
 * cardinality one today and the interesting question is what happens when it
 * does not: an axis marked for a different store must be skipped HERE, by a
 * rule, rather than swept in by a loop that assumes every standalone axis
 * belongs to whatever store it was handed.
 */
export function applyStandaloneScopes<T extends Narrowing<T>>(
  store: T,
  kind: StandaloneStore,
  scope: ScopeSelection,
): T {
  let out = store;
  for (const axis of SCOPE_AXES) {
    // `scoped(undefined)` returns the receiver, so an undeclared axis needs no
    // guard — one place decides what an absent scope means.
    if (axis.standalone === kind) out = out.scoped(scope[axis.field]);
  }
  return out;
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
 * A record's declared knowledge fences, validated (#511) — the second
 * two-reader field, and for the same reason as {@link declaredToolSurface}:
 * `dispatchToolWrapper` assembles its `childTools` and its four ctx-bound
 * dispatch tools **before** `runDefinition` runs, and
 * `toolWrapperDefinition.tools()` returns `input.childTools` verbatim, so a
 * `runDefinition`-only fence would leave a scoped wrapper fenced in its context
 * block and wide open in its tools. Narrowing is idempotent, so scoping early
 * and letting `runDefinition` re-derive is safe rather than merely tolerable.
 *
 * ## The fallback rule INVERTS here, and that is deliberate
 *
 * Everywhere else in this module an invalid value falls back to the site
 * default, which is safe — a bad `stepRatio` costs a step count. For a fence
 * the fallback IS full access, so a shape error must resolve to **deny-all**:
 * a non-array yields `[]`. An array with *some* invalid entries keeps the rest,
 * because dropping from an allowlist already narrows and rejecting a whole
 * scope over one typo buys nothing.
 *
 * `memoryScope: []` is honoured as deny-all rather than treated as "declared
 * nothing". That diverges from `targetToolsScopeError`, which rejects
 * `targetTools: []` — correctly, because "no tools" is an incoherent agent
 * while "verify against the task and nothing else" is a coherent posture.
 */
export function declaredScope(
  record: Partial<Record<ScopeField, unknown>>,
  rejected?: Record<string, unknown>,
): ScopeSelection {
  const out: ScopeSelection = {};
  for (const axis of SCOPE_AXES) {
    const raw = record[axis.field];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      if (rejected) rejected[axis.field] = raw;
      out[axis.field] = [];
      continue;
    }
    const valid = axis.validate();
    const kept = raw.filter(valid) as string[];
    if (kept.length !== raw.length && rejected) rejected[axis.field] = raw.filter((v) => !valid(v));
    out[axis.field] = kept;
  }
  return out;
}

/** What one dispatch's record says about how it runs, and whose it is. */
export interface ResolvedDispatchProfile {
  profile: DispatchProfile;
  /**
   * The record id this dispatch names, or `undefined` when it names none.
   *
   * Returned rather than re-derived by the caller, the shape `resolveRetrieval`
   * already uses: `def.recordId` is a definition-supplied thunk, and calling it
   * a second time per dispatch also meant a second copy of the emptiness guard
   * that could drift from this one. Set even when the record does not RESOLVE —
   * a dispatch owns its memory under the id it names, whether or not a record
   * with that id is still on disk.
   */
  recordId?: string;
}

/**
 * Reads the record a dispatch names, if it names one, and returns the execution
 * fields it validly declares.
 *
 * Never throws: a missing store, a missing record, a corrupt field or a store
 * that throws on read all yield the empty profile, which is byte-for-byte
 * today's behaviour. That matters more than it looks — this runs before every
 * dispatch in the process, `main` included.
 */
export function resolveDispatchProfile<TInput>(
  ctx: AgentContext,
  def: Pick<AgentDefinition<TInput, unknown>, 'id' | 'recordId'>,
  input: TInput,
): ResolvedDispatchProfile {
  const id = def.recordId?.(input);
  // An empty id is not a record id. `??` elsewhere would keep `''` and stamp
  // every memory with a blank owner that nothing can ever match.
  if (!id) return { profile: NONE };

  let record;
  try {
    record = ctx.stores.specialists?.get(id);
  } catch {
    return { profile: NONE, recordId: id };
  }
  if (!record) return { profile: NONE, recordId: id };

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
  Object.assign(profile, declaredScope(record, rejected));

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
    return { profile, recordId: id };
  }
  return { profile: NONE, recordId: id };
}
