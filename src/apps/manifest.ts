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

/** What a manifest Bernard authors today declares. */
export const LATEST_APP_SCHEMA_VERSION: AppSchemaVersion = 2;

export const AppActionSchema = z
  .object({
    /**
     * What the agent is asked to do. **Author-written and trusted** — this is
     * the instruction channel, and caller bytes never reach it. Args travel in
     * a separate, labelled data channel; see `src/apps/dispatch.ts`.
     */
    instructions: z.string().min(1).max(2000),
    /** Human-facing summary, surfaced by `bernard script --describe`. */
    description: z.string().max(400).optional(),
    /** The tool-wrapper specialist that backs this action. */
    specialistId: z.string().min(1),
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

export type AppAction = z.infer<typeof AppActionSchema>;

export const AppManifestSchema = z
  .object({
    schemaVersion: AppSchemaVersionSchema,
    id: z.string().regex(APP_ID_RE),
    name: z.string().min(1).max(80),
    description: z.string().max(400).optional(),
    actions: z.record(z.string().regex(ACTION_NAME_RE), AppActionSchema),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (Object.keys(m.actions).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'manifest declares no actions' });
    }
  });

export type AppManifest = z.infer<typeof AppManifestSchema>;

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
function formatZodError(err: z.ZodError): string {
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
