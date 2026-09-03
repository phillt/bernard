import { z } from 'zod';

/**
 * The app manifest: a closed, typed registry of the actions an external
 * program may invoke through `bernard script` (#419).
 *
 * The shape is the security boundary, not a convenience. A caller supplies an
 * **app id, a named action, and typed arguments** — never a prompt. A string
 * would cross as *instruction*, interpreted by a model holding the user's tool
 * authority; that is Hardy's confused deputy, with the attacker supplying the
 * designation and the agent supplying the authority. A named action crosses as
 * *data*: one that is unknown, or chosen by an attacker, simply does not
 * resolve. The published name for this is the Action-Selector Pattern
 * (arXiv:2506.08837), and OWASP LLM06:2025 recommends it directly.
 *
 * #420 hardens what is here — opaque capability handles, TTL and use counts,
 * session binding, provenance tagging, and real enforcement of
 * {@link AppAction.toolAllowlist} as persisted per-app permission rules. This
 * module defines the registry those layers attach to; it is deliberately not
 * described as being that layer itself.
 */

/**
 * The argument types an action may declare.
 *
 * Deliberately tiny and closed rather than general JSON Schema. An open schema
 * language re-opens exactly what the named action closed — and the three
 * non-string types are the interesting ones: `number`, `boolean` and `enum`
 * admit no prose at all, so an action built only from them is structurally
 * uninjectable. Prefer them wherever the domain allows.
 */
export const ArgSpecSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'enum']),
    required: z.boolean().default(false),
    /** Required for, and only valid on, `type: 'enum'`. */
    values: z.array(z.string()).min(1).optional(),
    /** Only meaningful for `type: 'string'`. Bounds what reaches the model. */
    maxLength: z.number().int().positive().max(32_000).optional(),
    description: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.type === 'enum' && !spec.values) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "type 'enum' requires `values`" });
    }
    if (spec.type !== 'enum' && spec.values) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`values` is only valid on type 'enum'",
      });
    }
    if (spec.type !== 'string' && spec.maxLength !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`maxLength` is only valid on type 'string'",
      });
    }
  });

export type ArgSpec = z.infer<typeof ArgSpecSchema>;

export const ACTION_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
export const APP_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const ARG_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * The manifest revisions this binary understands.
 *
 * A union rather than a bump, because {@link AppManifestSchema} is `.strict()`
 * in both directions: an older binary meeting a field it does not know rejects
 * the **whole app**, not just the field, and a newer binary must still read the
 * v1 manifests already on disk. So a revision is added here, never replaced.
 *
 * v1 (#419) — an action is backed by a tool-wrapper specialist.
 * v2 (#445) — an action may instead name a tool to call directly, with no
 * model in the loop. The v2-only fields are rejected on a v1 manifest by
 * {@link AppManifestSchema}'s refinement, so a manifest cannot half-declare
 * itself: the version it states is the version it is read as.
 */
export const AppSchemaVersionSchema = z.union([z.literal(1), z.literal(2)]);
export type AppSchemaVersion = z.infer<typeof AppSchemaVersionSchema>;

/**
 * How one tool parameter gets its value (#445).
 *
 * `$.<name>` reads a declared argument; anything else is a literal.
 *
 * **Arguments are mapped, never passed through.** Handing a caller's object to
 * a tool wholesale is how an undeclared field rides along — the same reason
 * `validateActionArgs` is `.strict()`. Naming each parameter explicitly means
 * the manifest author decided what reaches the tool, and a caller cannot add
 * to it.
 */
export const ARG_REF_PREFIX = '$.';

export const ToolDispatchSchema = z
  .object({
    kind: z.literal('tool'),
    /**
     * The tool to call. Eligibility is checked against the live registry, not
     * here: `ToolMeta.directInvocable` is a tool-local fact and this module is
     * a pure leaf. See `src/apps/direct-tool.ts`.
     */
    tool: z.string().min(1),
    /** Tool parameter name → `$.<declaredArg>` or a literal value. */
    args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  })
  .strict();

export const AgentDispatchSchema = z
  .object({
    kind: z.literal('agent'),
    /** The tool-wrapper specialist that backs this action. */
    specialistId: z.string().min(1),
    /**
     * What the agent is asked to do. **Author-written and trusted** — this is
     * the instruction channel, and caller bytes never reach it. Args travel in
     * a separate, labelled data channel; see `src/apps/dispatch.ts`.
     */
    instructions: z.string().min(1).max(2000),
  })
  .strict();

export const ActionDispatchSchema = z.discriminatedUnion('kind', [
  ToolDispatchSchema,
  AgentDispatchSchema,
]);

export type ToolDispatch = z.infer<typeof ToolDispatchSchema>;
export type AgentDispatch = z.infer<typeof AgentDispatchSchema>;
export type ActionDispatch = z.infer<typeof ActionDispatchSchema>;

/**
 * One action exactly as written on disk.
 *
 * Not the schema to parse with — {@link AppActionSchema} is, and it lifts. This
 * one exists because {@link AppManifestSchema} needs the pre-lift shape to
 * decide whether a v1 manifest declared a v2 field, a question the lifted form
 * can no longer answer.
 */
const RawAppActionSchema = z
  .object({
    /**
     * v1's flat agent fields. Lifted into {@link AppAction.dispatch} on read,
     * so nothing downstream branches on the schema version — every action,
     * whatever it was written as, arrives as a discriminated union.
     */
    instructions: z.string().min(1).max(2000).optional(),
    specialistId: z.string().min(1).optional(),
    /**
     * How this action runs (v2, #445). Absent on a v1 manifest, where the two
     * flat fields above say the same thing.
     */
    dispatch: ActionDispatchSchema.optional(),
    /** Human-facing summary, surfaced by `bernard script --describe`. */
    description: z.string().max(400).optional(),
    /** Declared args, by name. An undeclared key in a call is rejected. */
    args: z.record(z.string().regex(ARG_NAME_RE), ArgSpecSchema).default({}),
    /**
     * Tools this action's agent may use.
     *
     * In #419 this NARROWS the dispatch registry — intersected with the
     * specialist's own `targetTools`, so an action can only ever restrict what
     * the specialist already targets, never widen it. It is not yet an
     * enforcement layer: no persisted permission rules, no action-scoped
     * read/write refinement, no revocation. #420 owns those. Read it as
     * "which tools are constructed", not "what this agent is permitted".
     */
    toolAllowlist: z.array(z.string()).default([]),
    /** Defaults to `read-only`: an external caller has opted in to nothing. */
    toolMode: z.enum(['read-only', 'write']).default('read-only'),
    confirmMode: z.enum(['off', 'auto', 'strict']).default('auto'),
    /** Per-action wall clock. A `--timeout` flag may shorten it, never extend it. */
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(30 * 60_000)
      .optional(),
  })
  .strict();

export type RawAppAction = z.infer<typeof RawAppActionSchema>;

/**
 * One action as the rest of Bernard sees it: `dispatch` resolved, so nothing
 * downstream branches on the schema version.
 */
export type AppAction = Omit<RawAppAction, 'instructions' | 'specialistId' | 'dispatch'> & {
  dispatch: ActionDispatch;
};

/**
 * The rules that hold within one action, whatever manifest it came from.
 *
 * Shared rather than written into {@link AppManifestSchema} alone, because
 * {@link AppActionSchema} is exported and parsed directly. When these lived on
 * the manifest only, parsing a bare action skipped every one of them AND the
 * lift, yielding an object with `dispatch: undefined` typed as `AppAction` —
 * the exact shape the codebase says cannot exist. Tests are excluded from
 * `tsc`, so nothing caught it.
 */
function intraActionRules(action: RawAppAction, ctx: z.RefinementCtx, at: string[] = []): void {
  const path = (field: string) => [...at, field];
  const flat = action.instructions !== undefined || action.specialistId !== undefined;

  // Both forms at once is ambiguous, not redundant: they can disagree.
  if (action.dispatch && flat) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: path('dispatch'),
      message: 'declare either `dispatch` or `instructions`/`specialistId`, not both',
    });
  }
  if (!action.dispatch) {
    for (const field of ['instructions', 'specialistId'] as const) {
      if (action[field] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: path(field),
          message: 'required unless `dispatch` is declared',
        });
      }
    }
  }
  // Every `$.<name>` must name a declared arg. Caught here rather than at call
  // time so a typo is a broken manifest — loud, and costing nothing — instead
  // of a parameter that silently arrives as the literal `$.dset`.
  if (action.dispatch?.kind === 'tool') {
    for (const [param, value] of Object.entries(action.dispatch.args)) {
      if (typeof value !== 'string' || !value.startsWith(ARG_REF_PREFIX)) continue;
      const ref = value.slice(ARG_REF_PREFIX.length);
      if (!(ref in action.args)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path('dispatch'), 'args', param],
          message: `references undeclared argument "${ref}"`,
        });
      }
    }
  }
}

/**
 * Lifts a v1 action's flat fields into the v2 union.
 *
 * The lift happens on **read** rather than by rewriting files, because the
 * manifests on disk are the user's and a schema bump is not a reason to
 * rewrite them. Downstream code sees one shape either way, which is the whole
 * point — a `schemaVersion` check outside this module would be the version
 * leaking into logic.
 */
function liftAction(raw: RawAppAction): AppAction {
  const { instructions, specialistId, dispatch, ...rest } = raw;
  return {
    ...rest,
    dispatch: dispatch ?? {
      kind: 'agent',
      // Non-null by `intraActionRules`: an action with no `dispatch` must
      // carry both flat fields.
      specialistId: specialistId as string,
      instructions: instructions as string,
    },
  };
}

/**
 * The action schema everything parses with: validated, then lifted.
 *
 * Its output is {@link AppAction} — `dispatch` always present, the flat v1
 * fields gone — so there is no way to hold a half-resolved action.
 */
export const AppActionSchema = RawAppActionSchema.superRefine((action, ctx) =>
  intraActionRules(action, ctx),
).transform(liftAction);

export const AppManifestSchema = z
  .object({
    schemaVersion: AppSchemaVersionSchema,
    id: z.string().regex(APP_ID_RE),
    name: z.string().min(1).max(80),
    description: z.string().max(400).optional(),
    actions: z.record(z.string().regex(ACTION_NAME_RE), RawAppActionSchema),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (Object.keys(m.actions).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'manifest declares no actions' });
    }
    for (const [name, action] of Object.entries(m.actions)) {
      intraActionRules(action, ctx, ['actions', name]);
      // The one rule that needs manifest context, and the reason the record
      // above holds the RAW action schema: a manifest is read as the version it
      // states, and `dispatch` on a v1 manifest would make it half-v2 —
      // readable here and rejected wholesale by an older binary, which is the
      // failure the version union exists to avoid rather than to hide. After
      // the lift every action has a `dispatch`, so the question is unanswerable.
      if (action.dispatch && m.schemaVersion < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', name, 'dispatch'],
          message: '`dispatch` requires schemaVersion 2',
        });
      }
    }
  })
  .transform((m) => ({
    ...m,
    actions: Object.fromEntries(
      Object.entries(m.actions).map(([name, action]) => [name, liftAction(action)]),
    ),
  }));

export type AppManifest = z.output<typeof AppManifestSchema>;

/**
 * `.strict()` on every object above is load-bearing rather than tidiness.
 *
 * An unrecognised key is a manifest this binary does not fully understand.
 * Silently ignoring a misspelled `toolAllowlist` would produce an app that
 * reads as scoped and is not — precisely the failure #420 exists to prevent.
 * Reject instead, and say which key.
 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Formats a Zod failure into one line naming the offending path. */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const at = i.path.length > 0 ? i.path.join('.') : '(root)';
      return `${at}: ${i.message}`;
    })
    .join('; ');
}

export function parseAppManifest(raw: unknown): ParseResult<AppManifest> {
  const parsed = AppManifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
  return { ok: true, value: parsed.data };
}

/** A validated argument value. Never an object or array — see {@link ArgSpecSchema}. */
export type ArgValue = string | number | boolean;

/**
 * Builds the Zod schema for one action's arguments and validates a call
 * against it.
 *
 * Validated at read time as well as at write time (complete mediation): the
 * manifest file is user-editable between runs, so validating only on save is a
 * time-of-check/time-of-use gap.
 */
export function validateActionArgs(
  action: AppAction,
  raw: unknown,
): ParseResult<Record<string, ArgValue>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, spec] of Object.entries(action.args)) {
    let field: z.ZodTypeAny;
    switch (spec.type) {
      case 'string': {
        let s = z.string();
        if (spec.maxLength !== undefined) s = s.max(spec.maxLength);
        field = s;
        break;
      }
      case 'number':
        field = z.number().finite();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'enum':
        // `values` is guaranteed non-empty by ArgSpecSchema's refinement.
        field = z.enum(spec.values as [string, ...string[]]);
        break;
    }
    shape[name] = spec.required ? field : field.optional();
  }

  // `.strict()`: an undeclared key is rejected rather than ignored, so a caller
  // cannot smuggle an extra field alongside the declared ones.
  const parsed = z
    .object(shape)
    .strict()
    .safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
  return { ok: true, value: parsed.data as Record<string, ArgValue> };
}
