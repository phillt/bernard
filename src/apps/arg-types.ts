import { z } from 'zod';

/**
 * The argument vocabulary an action may declare, as a table (#588).
 *
 * **The closed set is the security boundary, not a convenience.** A caller
 * supplies an app id, a named action and typed arguments — never a prompt —
 * and the types are deliberately a tiny enumerable vocabulary rather than
 * general JSON Schema, because an open schema language re-opens exactly what
 * the named action closed. Everything below widens what a manifest can
 * *shape*; nothing widens what it can *say*.
 *
 * Until #588 the vocabulary was four scalars and a four-arm `switch`, which
 * had a visible cost: `ToolMeta.directInvocable` (#445) lets an applet action
 * call a tool with no model at all, and `file_edit_lines` and
 * `time_range_total` were excluded from that tier **not because they are
 * unsafe** but because a manifest could not name their arguments. So an applet
 * could overwrite a whole file with no model and had to pay for an agent to
 * edit three lines of one — the more common operation, the cheaper one, and
 * the one where an agent's nondeterminism actually hurts.
 *
 * ## Why a table rather than a fifth `switch` arm
 *
 * A type was described in five places: the zod enum, the cross-field
 * refinement ("`values` is only valid on type 'enum'"), the validator switch,
 * the starter page's control, and the prompt that teaches a model to author
 * one. Adding a type meant five edits, four of which fail silently — a missing
 * refinement arm accepts a nonsense spec, a missing control renders an input
 * that cannot carry the value. Here each type is ONE entry declaring its
 * schema fragment, its validator and its control, and {@link ARG_TYPES} is
 * what every consumer iterates.
 *
 * So adding a type is: one entry, one line in {@link ArgTypeId}, and — because
 * a prompt that lists an artefact is a second copy of it — the two sentences
 * in `applet-data-planner`'s prompt and `docs/applet-actions.md`. Everything
 * else derives: the enum at every level, the cross-field rules, the validator,
 * the version demand, the page control and `OWNERS`. Nothing branches on a
 * type id outside the table — {@link ArgTypeHandler.check} exists so that a
 * rule only one type has does not become the `switch` this replaced, wearing a
 * different hat. The two places that do branch, branch on a **closed
 * vocabulary this table owns**: `page-template.ts` on {@link ArgControl.tag}
 * to build markup, and the generated page script on `data-decode`, whose arms
 * are pinned to the declared decoders by `page-validate.test.ts`.
 *
 * The drift that remains is checked rather than trusted: an id with no entry
 * is a compile error (see `_everyArgTypeHasAnEntry`), a prompt that names a
 * type the table does not have or omits one it does fails
 * `bundled-manifest.test.ts`, and a declared decoder with no arm in the
 * generated page fails `page-validate.test.ts`.
 *
 * ## Depth, and why it is bounded
 *
 * Nesting is finite: {@link MAX_ARG_DEPTH} container hops, expanded eagerly,
 * with the nesting types dropped at the deepest level. That is deliberately
 * NOT `z.lazy` recursion, for two reasons. A bounded grammar is *more* closed
 * than a recursive one — the set of expressible shapes is enumerable, which is
 * the property this module exists to keep. And `src/tools/applet.ts`
 * advertises this schema to a model through `zod-to-json-schema`, which the AI
 * SDK calls with `$refStrategy: 'none'` — read off the installed package,
 * `@ai-sdk/ui-utils/dist/index.mjs:1573-1576`, where `useReferences` defaults
 * to `false` and nothing in `tool()`'s path sets it. So a `$ref` encoding is
 * not available to share a repeated level: `z.lazy` would have nothing to
 * share and would emit `$ref` cycles into a provider tool definition, which is
 * the #341 hazard class one level up. Load-bearing rather than stylistic.
 *
 * Eager expansion has a price and it is measured rather than assumed. The
 * level-0 JSON Schema goes from 429 bytes to 4,579, taking the `applet` tool
 * from 9,183 to 13,333 and the main agent's tool block from 41,968 to 46,118 —
 * **+9.9%**, on a prompt-cached prefix, so ~1,040 tokens written once per
 * session and read at a tenth of that per step.
 *
 * It cannot be made conditional **on anything turn-scoped** — and the narrower
 * claim is the true one, so it is worth stating precisely, because this is
 * where someone trying to shrink the prefix will land. The prompt cache needs
 * the block byte-stable across turns *within* a session (#269), which is why
 * `createTools` is a pure function of its arguments; but purity *in its
 * arguments* is exactly what permits argument-driven conditionality, and
 * `opts.surface` already varies this same block that way. A session-resolved
 * flag would preserve byte-stability as `surface` does. It is not built
 * because gating applet authoring hides a capability rather than costing one,
 * and 4,150 bytes is a fair price for it — not because the door is closed.
 *
 * Two knobs hold that number down, and both are declarative rather than
 * hand-tuned per level. `nestedOnly` keeps `object` out of level 0, where the
 * expansion is most expensive. And a field's `hint` is optional, because the
 * deepest level appears four times.
 *
 * The bound of 3 is not a round number — it is exactly what `file_edit_lines`
 * needs, `delete` included. A bound of 2 measures ~1.8 KB and would leave that
 * tool **entirely** ineligible rather than partly usable, because
 * `isRepresentableParam` refuses a parameter whose *deepest* leaf a manifest
 * cannot reach: `edits[].lines` is one hop past it, and one unreachable leaf
 * disqualifies the whole tool.
 */

/** A validated argument value. Nested only as far as {@link MAX_ARG_DEPTH}. */
export type ArgValue = string | number | boolean | ArgValue[] | { [key: string]: ArgValue };

/**
 * One declared argument, at any level.
 *
 * Hand-written rather than inferred, and deliberately flat: the schema is a
 * different object per level (a level-3 spec cannot nest), so `z.infer` would
 * give four incompatible types and a recursive walk could not be written over
 * them. Every level's output is assignable to this one — which is the point.
 */
export interface ArgSpec {
  type: ArgTypeId;
  required: boolean;
  /** `enum` only: the permitted values. */
  values?: string[];
  /** `string` only: bounds what reaches a tool or a model. */
  maxLength?: number;
  /** `list` only: bounds how many elements a caller may send. */
  maxItems?: number;
  /** `list` only: what one element is. */
  of?: ArgSpec;
  /** `object` only: the fields, by name. */
  fields?: Record<string, ArgSpec>;
  description?: string;
}

/** Argument and object-field names. Lowercase, so a shape reads as data. */
export const ARG_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** Container hops from a declared argument down to a scalar leaf. */
export const MAX_ARG_DEPTH = 3;

/**
 * Default ceiling on a list a caller may send.
 *
 * A bound is not optional here: without one a browser page posts 100k elements
 * and every layer below — validation, the mapping, the tool itself — walks
 * them. An author may lower it with `maxItems` and may not raise it past
 * {@link MAX_DECLARABLE_ITEMS}.
 */
export const DEFAULT_MAX_ITEMS = 200;
export const MAX_DECLARABLE_ITEMS = 1000;

/** Fields one `object` spec may declare. A shape, not a document. */
export const MAX_OBJECT_FIELDS = 32;

export type ArgTypeId = 'string' | 'number' | 'boolean' | 'enum' | 'list' | 'object';

/**
 * How the starter page collects a value of this type.
 *
 * Declared as DATA rather than as markup, so `page-template.ts` keeps the only
 * copy of the HTML escaping — a handler that returned a string could emit an
 * unescaped attribute, and the manifest reaching that renderer is
 * user-editable.
 */
export interface ArgControl {
  /**
   * How the generated page turns the control back into a JSON value.
   *
   * `el.value` is always a string, so a control with no decoder sends `"5"`
   * where a `number` argument is declared and `"true"` where a `boolean` is —
   * which the scaffold did for every non-string argument before this. One
   * generic rule in the page script, keyed on this value, is what makes
   * adding a type one entry here rather than an edit to generated JavaScript.
   */
  readonly decode: 'text' | 'number' | 'checkbox' | 'json';
  readonly tag: 'input' | 'select' | 'textarea';
  /** Static attributes; the renderer escapes both halves. */
  readonly attrs?: Readonly<Record<string, string>>;
  /** `select` only: the options to render. */
  options?(spec: ArgSpec): readonly string[];
  /** `textarea` only: the initial contents, so the control starts valid. */
  initial?(spec: ArgSpec): string;
}

/** One `ArgSpec` key, owned by the type that declares it. */
export interface ArgSpecField {
  readonly key: Exclude<keyof ArgSpec, 'type' | 'required' | 'description'>;
  /** Demanded on this type, rather than merely permitted. */
  readonly required: boolean;
  /**
   * One short phrase for the model, where the key's meaning is not obvious.
   *
   * Optional, and measured: the eager expansion emits a scalar type's fields
   * eight times, so a hint on `values` or `maxLength` — keys that say what
   * they are — costs ~700 bytes of a cached prompt prefix to restate their own
   * names. The nesting keys earn theirs.
   */
  readonly hint?: string;
  /**
   * The zod fragment. `child` is the spec schema one level down, supplied only
   * to a nesting type and never `null` for one — {@link argSpecFieldsAt} drops
   * nesting types at the deepest level, so a nesting field is never built
   * without a child to point at.
   */
  schema(child: z.ZodTypeAny): z.ZodTypeAny;
}

export interface ArgTypeHandler {
  readonly id: ArgTypeId;
  /**
   * The manifest revision that can express this type.
   *
   * On the handler rather than in a version table, so adding a type carries
   * its own version demand — `schemaVersionDemands` reads this, so a manifest
   * using a newer type is stamped and refused against the right revision
   * without anyone remembering to add a case.
   */
  readonly since: number;
  /** One line, for the model and for `--describe`. */
  readonly summary: string;
  /** True when this type contains other specs. Dropped at the deepest level. */
  readonly nests?: boolean;
  /**
   * True when this type may only appear INSIDE a container.
   *
   * `object` is the only one, and the reason is expressiveness rather than
   * safety: a top-level record argument is always decomposable into sibling
   * scalar arguments (`{width, height}` is `width` and `height`), so it buys
   * nothing there. Inside a variable-length list it is the only way to give an
   * element structure, which is exactly the `file_edit_lines` case. Keeping it
   * out of level 0 also halves the advertised schema at the root, where the
   * expansion is most expensive.
   */
  readonly nestedOnly?: boolean;
  /** `ArgSpec` keys this type owns. Every other type rejects them. */
  readonly fields: readonly ArgSpecField[];
  /** Child specs, with the path segment to report an issue at. */
  children?(spec: ArgSpec): ReadonlyArray<{ at: (string | number)[]; spec: ArgSpec }>;
  /**
   * Any rule this type owns beyond "which keys are legal on it".
   *
   * On the entry rather than as an arm in {@link checkArgSpec}, because an arm
   * there is the `switch` this table replaced, wearing a different hat: one
   * type-specific rule outside the table and "adding a type is one entry" has
   * already stopped being true.
   */
  check?(spec: ArgSpec, ctx: z.RefinementCtx, at: (string | number)[]): void;
  /** The validator for a value of this type. `sub` builds a child spec's. */
  build(spec: ArgSpec, sub: (child: ArgSpec) => z.ZodTypeAny): z.ZodTypeAny;
  readonly control: ArgControl;
}

/**
 * The vocabulary. One entry per type, and adding one is one entry.
 *
 * Declaration order is what the model sees in the `type` enum. Scalars first
 * and containers last, with `string` leading because it is the familiar one —
 * not because it is preferred. The prose beside every surface says the
 * opposite: prefer `number` / `boolean` / `enum`, which admit no prose at all,
 * so an action built from them is structurally uninjectable.
 */
const TABLE = [
  {
    id: 'string',
    since: 1,
    summary: 'free text; takes an optional `maxLength`',
    fields: [
      {
        key: 'maxLength',
        required: false,
        schema: () => z.number().int().positive().max(32_000),
      },
    ],
    build: (spec) => (spec.maxLength === undefined ? z.string() : z.string().max(spec.maxLength)),
    control: { decode: 'text', tag: 'input' },
  },
  {
    id: 'number',
    since: 1,
    summary: 'a number',
    fields: [],
    // `.finite()`: `Infinity` and `NaN` are numbers to zod and are not values
    // any tool below wants to meet.
    build: () => z.number().finite(),
    control: { decode: 'number', tag: 'input', attrs: { type: 'number' } },
  },
  {
    id: 'boolean',
    since: 1,
    summary: 'true or false',
    fields: [],
    build: () => z.boolean(),
    control: { decode: 'checkbox', tag: 'input', attrs: { type: 'checkbox' } },
  },
  {
    id: 'enum',
    since: 1,
    summary: 'one of a fixed list, given as `values`',
    fields: [
      {
        key: 'values',
        required: true,
        schema: () => z.array(z.string()).min(1),
      },
    ],
    // Non-empty by this type's own `required` field, checked before anything
    // is built; `z.never()` rather than a widening fallback keeps a spec that
    // somehow reached here without one failing closed.
    build: (spec) =>
      spec.values?.length ? z.enum(spec.values as [string, ...string[]]) : z.never(),
    control: {
      decode: 'text',
      tag: 'select',
      options: (spec) => spec.values ?? [],
    },
  },
  {
    id: 'list',
    since: 4,
    summary: 'several of one thing; `of` says what one element is',
    nests: true,
    fields: [
      { key: 'of', required: true, hint: 'what ONE element is', schema: (child) => child },
      {
        key: 'maxItems',
        required: false,
        hint: `most elements a caller may send (default ${DEFAULT_MAX_ITEMS})`,
        schema: () => z.number().int().positive().max(MAX_DECLARABLE_ITEMS),
      },
    ],
    children: (spec) => (spec.of ? [{ at: ['of'], spec: spec.of }] : []),
    // `sub(spec.of)` and not the optionality-aware form: `required` says
    // whether a KEY must be present, and a list element has no key. An element
    // either exists or the list is shorter.
    build: (spec, sub) =>
      spec.of ? z.array(sub(spec.of)).max(spec.maxItems ?? DEFAULT_MAX_ITEMS) : z.never(),
    control: {
      decode: 'json',
      tag: 'textarea',
      attrs: { rows: '3' },
      initial: () => '[]',
    },
  },
  {
    id: 'object',
    since: 4,
    summary: 'a record with named fields, given as `fields`',
    nests: true,
    nestedOnly: true,
    fields: [
      {
        key: 'fields',
        required: true,
        hint: 'the named fields, each its own spec',
        schema: (child) => z.record(z.string().regex(ARG_NAME_RE), child),
      },
    ],
    children: (spec) =>
      Object.entries(spec.fields ?? {}).map(([name, child]) => ({
        at: ['fields', name],
        spec: child,
      })),
    check: (spec, ctx, at) => {
      const count = Object.keys(spec.fields ?? {}).length;
      if (count >= 1 && count <= MAX_OBJECT_FIELDS) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...at, 'fields'],
        message: `an object declares 1 to ${MAX_OBJECT_FIELDS} fields, not ${count}`,
      });
    },
    build: (spec, sub) => {
      const fields = spec.fields;
      if (!fields || Object.keys(fields).length === 0) return z.never();
      const shape: Record<string, z.ZodTypeAny> = {};
      // `applyRequired`, not a second copy of the rule: `required` means the
      // same thing on an object field as on a top-level argument. Through
      // `sub` rather than `buildArgField`, so the recursion still goes through
      // the entry point this handler was handed.
      for (const [name, child] of Object.entries(fields)) {
        shape[name] = applyRequired(child, sub(child));
      }
      // `.strict()` for the reason `validateActionArgs` is strict one level up:
      // an undeclared key inside an element is the same smuggling, one level
      // down, and silently ignoring it is what makes a shape read as closed
      // when it is not.
      return z.object(shape).strict();
    },
    control: {
      decode: 'json',
      tag: 'textarea',
      attrs: { rows: '3' },
      initial: () => '{}',
    },
  },
] as const satisfies readonly ArgTypeHandler[];

/**
 * The vocabulary every consumer iterates.
 *
 * Two names for one array, and the private one is what buys the check below.
 * `as const` is required for `Exclude` to see the literal ids, and it also
 * narrows each entry to exactly the keys it wrote — so `h.nestedOnly` on an
 * entry that omits it stops compiling. Widening here restores the declared
 * interface for every reader, and both names point at the same array.
 */
export const ARG_TYPES: readonly ArgTypeHandler[] = TABLE;

/**
 * Every {@link ArgTypeId} really has an entry above, checked by the compiler.
 *
 * {@link ARG_TYPE_IDS} is derived FROM the table, so a runtime test comparing
 * the two is vacuous in exactly this direction: an id in the union with no
 * entry is invisible to it, and what happens at runtime is `argTypeHandler`
 * returning `undefined` and `buildArgValidator` failing closed — safe, silent,
 * and indistinguishable from a typo. Add `'date'` to the union with no entry
 * and this assignment fails to compile, naming it. Production code, because
 * `tsconfig.json` excludes tests from the program (#509).
 */
type Unimplemented = Exclude<ArgTypeId, (typeof TABLE)[number]['id']>;
const _everyArgTypeHasAnEntry: [Unimplemented] extends [never] ? true : Unimplemented = true;
void _everyArgTypeHasAnEntry;

const BY_ID = new Map<string, ArgTypeHandler>(ARG_TYPES.map((h) => [h.id, h]));

/** Every declarable type, including the ones only legal inside a container. */
export const ARG_TYPE_IDS: readonly ArgTypeId[] = ARG_TYPES.map((h) => h.id);

/** Which types a given `ArgSpec` key is legal on. Derived, never restated. */
const OWNERS: ReadonlyMap<string, readonly ArgTypeId[]> = (() => {
  const out = new Map<string, ArgTypeId[]>();
  for (const handler of ARG_TYPES) {
    for (const field of handler.fields) {
      const owners = out.get(field.key);
      if (owners) owners.push(handler.id);
      else out.set(field.key, [handler.id]);
    }
  }
  return out;
})();

export function argTypeHandler(id: string): ArgTypeHandler | undefined {
  return BY_ID.get(id);
}

/** The types legal at one nesting level. */
function handlersAt(depth: number): readonly ArgTypeHandler[] {
  return ARG_TYPES.filter(
    (h) => (depth > 0 || !h.nestedOnly) && (depth < MAX_ARG_DEPTH || !h.nests),
  );
}

const LEVELS = new Map<number, z.ZodTypeAny>();

/**
 * The spec schema at one nesting level, composed from the table.
 *
 * Deliberately effects-free at EVERY level — the cross-field rules run in one
 * recursive pass at the top (see {@link checkArgSpec}) rather than as a
 * refinement per level. A `ZodEffects` nested inside a `ZodObject` changes what
 * `zod-to-json-schema` emits for the tool parameter `applet.ts` advertises,
 * which is the hazard #341 records for `.transform`; and one traversal can
 * report a nested issue at its real path, which per-level refinements cannot.
 */
function argSpecFieldsAt(depth: number): z.ZodTypeAny {
  const cached = LEVELS.get(depth);
  if (cached) return cached;

  const handlers = handlersAt(depth);
  const child = depth < MAX_ARG_DEPTH ? argSpecFieldsAt(depth + 1) : null;
  const ids = handlers.map((h) => h.id) as [ArgTypeId, ...ArgTypeId[]];

  // The summary is emitted at level 0 ONLY, and that is a budget decision
  // rather than an oversight: the deeper levels appear 1, 2 and 4 times in the
  // eager expansion, so a 200-character description there is 1.4 KB of a
  // cached prompt prefix restating what the root already said. It names the
  // types a nested spec may use, so nothing is hidden by the omission.
  const summary = ARG_TYPES.map((h) => `${h.id}: ${h.summary}`).join('; ');
  const shape: Record<string, z.ZodTypeAny> = {
    type:
      depth === 0
        ? z.enum(ids).describe(`${summary}. \`object\` is legal only inside a \`list\`.`)
        : z.enum(ids),
    required: z.boolean().default(false),
  };
  for (const handler of handlers) {
    for (const field of handler.fields) {
      // A key owned by two types gets one schema, the first declaration's.
      // `arg-types.test.ts` asserts no key is declared twice, so this is a
      // guard against a future duplicate rather than a live merge rule.
      if (field.key in shape) continue;
      // Optional on the OBJECT whatever the handler says: "required on this
      // type" is a cross-field rule, and expressing it in the shape would
      // demand `values` of a `string` spec.
      const built = field.schema(child as z.ZodTypeAny).optional();
      shape[field.key] = field.hint ? built.describe(field.hint) : built;
    }
  }
  shape.description = z.string().max(200).optional();

  const built = z.object(shape).strict();
  LEVELS.set(depth, built);
  return built;
}

/**
 * The arg-spec FIELDS, without the cross-field rules.
 *
 * Exported because `src/tools/applet.ts` advertises this shape to a model and
 * needs the object: a refinement makes it a `ZodEffects`, which changes what
 * `zod-to-json-schema` emits for a tool parameter. Sharing the object rather
 * than re-typing it is what stops a field added here from being silently
 * unauthorable there.
 *
 * The cast is the one place the dynamic builder meets a declared contract.
 * `z.infer` over a composed, per-level shape would give four incompatible
 * types (a level-3 spec cannot nest), so the schema states its output as
 * {@link ArgSpec} — which every level's real output is assignable to.
 */
export const ArgSpecFields = argSpecFieldsAt(0) as unknown as z.ZodObject<
  { type: z.ZodEnum<[string, ...string[]]> } & Record<string, z.ZodTypeAny>,
  'strict',
  z.ZodTypeAny,
  ArgSpec,
  unknown
>;

/**
 * The cross-field rules, applied to a spec and every spec beneath it.
 *
 * One recursive pass rather than a refinement per level, so a bad nested spec
 * is reported at `fields.edits.of.fields.line` rather than at the root — and
 * so the whole tree stays a plain `ZodObject`.
 */
export function checkArgSpec(
  spec: ArgSpec,
  ctx: z.RefinementCtx,
  at: (string | number)[] = [],
): void {
  const handler = BY_ID.get(spec.type);
  // Unreachable through the schema (the `type` enum is built from the table),
  // and stated rather than assumed: a spec built in code could name anything.
  if (!handler) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...at, 'type'],
      message: `unknown argument type "${spec.type}"`,
    });
    return;
  }

  const record = spec as unknown as Record<string, unknown>;
  for (const [key, owners] of OWNERS) {
    if (record[key] === undefined || owners.includes(spec.type)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...at, key],
      message: `\`${key}\` is only valid on type ${owners.map((o) => `'${o}'`).join(' or ')}`,
    });
  }
  for (const field of handler.fields) {
    if (!field.required || record[field.key] !== undefined) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...at, field.key],
      message: `type '${handler.id}' requires \`${field.key}\``,
    });
  }

  handler.check?.(spec, ctx, at);

  for (const child of handler.children?.(spec) ?? []) {
    checkArgSpec(child.spec, ctx, [...at, ...child.at]);
  }
}

/** The zod validator for one declared argument's VALUE, ignoring optionality. */
export function buildArgValidator(spec: ArgSpec): z.ZodTypeAny {
  const handler = BY_ID.get(spec.type);
  // Fails CLOSED. A widening fallback here would accept anything for a type
  // nothing knows how to validate, on the path a browser page reaches.
  if (!handler) return z.never();
  return handler.build(spec, buildArgValidator);
}

/**
 * What `required` means: whether the KEY may be absent.
 *
 * One rule, two callers — a top-level argument and an object field — because
 * they mean the same thing by it. A list element is deliberately NOT a caller:
 * an element has no key, so it either exists or the list is shorter.
 */
export function applyRequired(spec: ArgSpec, value: z.ZodTypeAny): z.ZodTypeAny {
  return spec.required ? value : value.optional();
}

/** The validator for one declared argument, optionality included. */
export function buildArgField(spec: ArgSpec): z.ZodTypeAny {
  return applyRequired(spec, buildArgValidator(spec));
}

/**
 * The manifest revision a set of specs demands, walking nested types too.
 *
 * Read off {@link ArgTypeHandler.since}, so adding a type carries its own
 * version demand rather than needing a case somewhere else. It names the type
 * that raised it, because "requires schemaVersion 4" with nothing pointing at
 * the reason is a refusal an author has to go looking for.
 */
export function argSpecsSince(specs: Iterable<ArgSpec>): { version: number; because?: ArgTypeId } {
  let version = 1;
  let because: ArgTypeId | undefined;
  const walk = (spec: ArgSpec): void => {
    const handler = BY_ID.get(spec.type);
    if (!handler) return;
    if (handler.since > version) {
      version = handler.since;
      because = handler.id;
    }
    for (const child of handler.children?.(spec) ?? []) walk(child.spec);
  };
  for (const spec of specs) walk(spec);
  return { version, because };
}
