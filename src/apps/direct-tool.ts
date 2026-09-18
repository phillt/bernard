import { readToolMeta } from '../framework/tools/adapter.js';
// The leaf, not `./manifest.js`: this asks what a manifest could EXPRESS, and
// the depth bound is the one fact it needs.
import { MAX_ARG_DEPTH } from './arg-types.js';

/**
 * Which tools an applet action may call **directly, with no model** (#445).
 *
 * The tier this enables is the middle one: pure computation belongs in the
 * applet's own JavaScript, judgment needs an agent, and everything between —
 * effects on the machine with a known shape — is a function call. Paying for a
 * model to move a file is not only waste, it is *nondeterministic*: an agent
 * may skip a file or invent a path, where a loop does neither.
 *
 * Eligibility is an opt-in flag on the tool (`ToolMeta.directInvocable`), not
 * a list kept here — a list can disagree with the tool it describes, and the
 * disagreement is fail-open. This module is the *reader* of that flag plus the
 * two structural checks a flag cannot make on its own.
 */

/** Zod nodes a scalar `ArgSpec` can produce a value for. */
const SCALAR_TYPES = new Set(['ZodString', 'ZodNumber', 'ZodBoolean', 'ZodEnum', 'ZodLiteral']);
/** Wrappers that do not change whether the value underneath is a scalar. */
const TRANSPARENT_TYPES = new Set([
  'ZodOptional',
  'ZodNullable',
  'ZodDefault',
  'ZodEffects',
  'ZodBranded',
]);

function typeNameOf(node: unknown): string {
  return (node as { _def?: { typeName?: string } })?._def?.typeName ?? '';
}

function innerOf(node: unknown): unknown {
  const def = (node as { _def?: Record<string, unknown> })?._def ?? {};
  return def.innerType ?? def.schema ?? def.type;
}

/** Guards a pathological schema; unrelated to the arg grammar's own bound. */
const MAX_WRAPPER_HOPS = 16;

/**
 * True when a manifest could supply this parameter.
 *
 * Two budgets, and conflating them is the mistake worth naming. `hops` counts
 * CONTAINERS and is the arg grammar's own bound — a manifest can declare
 * {@link MAX_ARG_DEPTH} levels of `list` / `object` and no more, so a parameter
 * whose deepest leaf sits past that is one no declared argument can become.
 * `wraps` counts `ZodOptional` / `ZodDefault` / friends, which change nothing
 * about the shape and exist only to stop a pathological schema recursing
 * forever.
 *
 * Sharing {@link MAX_ARG_DEPTH} with the grammar is what makes the two agree.
 * The failure if they drift is silent and fail-OPEN: this would admit a tool
 * whose parameter a manifest cannot name, `mapToolArgs` would omit it, and the
 * tool would be called with a required argument simply missing — which is
 * exactly the class `directInvocableRefusal` exists to refuse at authoring
 * time. `arg-types.test.ts` pins the agreement at the boundary, in both
 * directions.
 */
export function isRepresentableParam(node: unknown, hops = 0, wraps = 0): boolean {
  if (wraps > MAX_WRAPPER_HOPS) return false;
  const t = typeNameOf(node);
  if (SCALAR_TYPES.has(t)) return true;
  if (TRANSPARENT_TYPES.has(t)) return isRepresentableParam(innerOf(node), hops, wraps + 1);
  if (hops >= MAX_ARG_DEPTH) return false;
  if (t === 'ZodArray') return isRepresentableParam(innerOf(node), hops + 1, wraps + 1);
  if (t === 'ZodObject') {
    const shape = (node as { shape?: Record<string, unknown> })?.shape;
    // A `ZodRecord` is deliberately absent: an `object` spec declares its
    // fields by name, so an open-keyed record is not something it can produce.
    if (!shape || typeof shape !== 'object') return false;
    // `{}` is not vacuously representable: an `object` spec must declare at
    // least one field, so nothing in the grammar produces an empty record.
    const children = Object.values(shape);
    if (children.length === 0) return false;
    return children.every((child) => isRepresentableParam(child, hops + 1, wraps + 1));
  }
  return false;
}

/** Parameter names of `tool` that a manifest could not supply a value for. */
export function unrepresentableParams(tool: unknown): string[] {
  const shape = (tool as { parameters?: { shape?: Record<string, unknown> } })?.parameters?.shape;
  if (!shape) return [];
  return Object.entries(shape)
    .filter(([, node]) => !isRepresentableParam(node))
    .map(([name]) => name);
}

/**
 * Why `toolName` may not back a `kind: 'tool'` action, or `null` if it may.
 *
 * Three refusals, in the order a manifest author hits them.
 *
 * The flag is the deliberate one. The `dangerous` check is what actually keeps
 * `shell` out and is stated as an invariant rather than a name: its parameters
 * are `{command: string}` — a *representable* scalar, so the shape check alone
 * would let it through — and a free-form command line reachable from a web
 * page is arbitrary host code execution, the hole this whole design closes.
 * A tool classified `dangerous` is by definition not something a caller may
 * reach without a person in the loop.
 *
 * Representability is last because it is about what a manifest can *express*,
 * not about trust. It used to exclude `file_edit_lines` and `time_range_total`,
 * whose arguments nest; #588 gave the arg vocabulary `list` and `object`, so
 * both are expressible now and both are eligible. What it still refuses is a
 * shape past {@link MAX_ARG_DEPTH}, an open-keyed record, and a union — none
 * of which any declared argument can become.
 */
export function directInvocableRefusal(toolName: string, tool: unknown): string | null {
  if (!tool) {
    // Says only what it checked. It used to add "or is not in this action's
    // tool allowlist", which cannot be true: `buildRegistry` builds an
    // unfiltered worker surface, and `grantedToolNames` is called only on the
    // agent arm — so a tool action's `toolAllowlist` never narrows this
    // lookup. Whether it SHOULD is a live question and its own change; the
    // controls actually bounding this tier are `directInvocable` (five
    // read-mostly tools), the write scope and the posture gates. A message
    // naming a check that does not run is the failure the reviewer prompt was
    // just corrected for.
    return `Action names tool "${toolName}", which does not exist.`;
  }
  const meta = readToolMeta(tool as never);
  if (!meta?.directInvocable) {
    return `Tool "${toolName}" cannot be called directly by an app action. Back this action with a specialist instead.`;
  }
  if (meta.kind === 'dangerous') {
    return `Tool "${toolName}" is classified dangerous and can never be called without a person in the loop.`;
  }
  const unrepresentable = unrepresentableParams(tool);
  if (unrepresentable.length > 0) {
    return `Tool "${toolName}" takes arguments an app manifest cannot express: ${unrepresentable.join(', ')}.`;
  }
  return null;
}

/**
 * The same eligibility question, asked with only a NAME — for the write path.
 *
 * A manifest naming an ineligible tool used to be accepted at authoring and
 * refused at the click, as an HTTP 500 the user could do nothing with. The
 * observed case was `{kind:'tool', tool:'datetime'}`: written, reported as
 * created, dead on arrival. `intraActionRules` already sets the precedent for
 * catching this class at write time — "loud, and costing nothing" — it simply
 * could not do this one, because eligibility is not manifest-local.
 *
 * It builds a registry and delegates to {@link directInvocableRefusal} rather
 * than consulting a name list, for the reason this module's header gives: a
 * list disagrees with the tool it describes, and the disagreement is
 * fail-open. One predicate, two callers.
 *
 * **This does not replace the dispatch-time check**, and must not be made to.
 * A manifest is user-editable between runs, so a write-time check alone is a
 * time-of-check/time-of-use gap (#420 R6). This is an early, better-worded
 * refusal in front of the real one.
 */
let registryPromise: Promise<Record<string, unknown>> | undefined;

function eligibilityRegistry(): Promise<Record<string, unknown>> {
  // Memoized on the PROMISE so concurrent callers share one build — but a
  // rejection resets it. `cached ??= build()` caches a rejected promise too,
  // which would poison the process for its lifetime after one transient
  // failure.
  registryPromise ??= buildEligibilityRegistry().catch((err: unknown) => {
    registryPromise = undefined;
    throw err;
  });
  return registryPromise;
}

async function buildEligibilityRegistry(): Promise<Record<string, unknown>> {
  // A `worker` surface is enough: every `directInvocable` tool is in an
  // `audience: 'any'` group, so nothing eligible is filtered out — and
  // `augmentTools` is deliberately skipped, since `readToolMeta` and
  // `parameters.shape` are both present before augmentation.
  const { createTools } = await import('../tools/index.js');
  const { MemoryStore } = await import('../memory.js');
  return (await createTools(
    // No `ToolOptions` worth supplying: nothing here is executed, only read.
    {} as never,
    new MemoryStore(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { surface: 'worker' },
  )) as unknown as Record<string, unknown>;
}

export async function directInvocableRefusalByName(toolName: string): Promise<string | null> {
  let registry: Record<string, unknown>;
  try {
    registry = await eligibilityRegistry();
  } catch (err) {
    // Fail CLOSED. Returning `null` here would let an unverifiable manifest
    // through on an infrastructure error, which is the fail-open shape this
    // module's header refuses for name lists.
    return (
      `Could not verify that tool "${toolName}" may be called directly ` +
      `(${err instanceof Error ? err.message : String(err)}).`
    );
  }
  return directInvocableRefusal(toolName, registry[toolName]);
}

/**
 * Whether a manifest's `dispatch.args` name parameters the tool actually has.
 *
 * The sibling of the eligibility check and the same class of defect: a
 * misspelled `pth` for `file_write` is today an `invalid_manifest` 500 at
 * click time, indistinguishable to the user from the `datetime` case.
 *
 * Only the parameter NAMES and the required set are checked. A `$.<arg>`
 * reference's runtime value is unknowable here, so type-checking the mapping
 * would work for the subset with no references and silently not for the rest —
 * a check that applies sometimes is worse than one that says what it covers.
 */
export async function toolArgRefusal(
  toolName: string,
  args: Record<string, string | number | boolean>,
): Promise<string | null> {
  let registry: Record<string, unknown>;
  try {
    registry = await eligibilityRegistry();
  } catch {
    // The eligibility check already reported the build failure; a second copy
    // of the same message helps nobody.
    return null;
  }
  const tool = registry[toolName];
  const shape = shapeOf(tool);
  if (!shape) return null;

  const known = Object.keys(shape);
  const unknown = Object.keys(args).filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    return (
      `Tool "${toolName}" has no parameter ${unknown.map((u) => `"${u}"`).join(', ')}. ` +
      `Its parameters are: ${known.join(', ')}.`
    );
  }

  const missing = known.filter((name) => isRequired(shape[name]) && !(name in args));
  if (missing.length > 0) {
    return (
      `Tool "${toolName}" requires ${missing.map((m) => `"${m}"`).join(', ')}, which this ` +
      `action's dispatch.args does not map. Map each to a literal or to \`$.<declaredArg>\`.`
    );
  }
  return null;
}

function shapeOf(tool: unknown): Record<string, unknown> | null {
  const shape = (tool as { parameters?: { shape?: Record<string, unknown> } })?.parameters?.shape;
  return shape && typeof shape === 'object' ? shape : null;
}

/** Optional, nullable and defaulted parameters need no mapping. */
function isRequired(node: unknown): boolean {
  const name = typeNameOf(node);
  return name !== 'ZodOptional' && name !== 'ZodDefault' && name !== 'ZodNullable';
}
