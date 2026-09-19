import { z } from 'zod';
import { isGrantableSource, MAX_SOURCES_PER_DIRECTIVE } from '../host/csp-grant.js';
import {
  ARG_NAME_RE,
  ArgSpecFields,
  argSpecsSince,
  buildArgField,
  checkArgSpec,
  type ArgSpec,
  type ArgValue,
} from './arg-types.js';

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
 * The argument types an action may declare live in `./arg-types.ts`, as a
 * table rather than as four hand-written cases (#588).
 *
 * Re-exported here because this is the module every consumer already imports,
 * and because the vocabulary IS part of the manifest contract. What moved is
 * the shape, not the rule: the set is still tiny and closed rather than general
 * JSON Schema, for the reason above — an open schema language re-opens exactly
 * what the named action closed — and `number`, `boolean` and `enum` still admit
 * no prose at all, so an action built only from them is structurally
 * uninjectable. Prefer them wherever the domain allows.
 */
export { ArgSpecFields, ARG_TYPES, ARG_TYPE_IDS, MAX_ARG_DEPTH } from './arg-types.js';
export type { ArgSpec, ArgValue, ArgTypeHandler, ArgTypeId } from './arg-types.js';

/**
 * The spec schema everything parses with: the fields, plus the cross-field
 * rules applied to this spec and every spec nested beneath it.
 */
export const ArgSpecSchema = ArgSpecFields.superRefine((spec, ctx) => checkArgSpec(spec, ctx));

export const ACTION_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
export const APP_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

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
 * v3 (#467) — the applet may DECLARE the external origins it needs and why.
 * v4 (#588) — an argument may be a `list` or an `object`, so an action can
 * name a nested tool parameter. Demanded by {@link schemaVersionDemands} off
 * `ArgTypeHandler.since`, not by a case here, so a type added later carries
 * its own version.
 */
export const AppSchemaVersionSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type AppSchemaVersion = z.infer<typeof AppSchemaVersionSchema>;

/** The newest revision this binary can write. */
export const LATEST_APP_SCHEMA_VERSION = 4 satisfies AppSchemaVersion;

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

export const ToolDispatchFields = z
  .object({
    kind: z.literal('tool'),
    /**
     * The tool to call. Eligibility is checked against the live registry, not
     * here: `ToolMeta.directInvocable` is a tool-local fact and this module is
     * a pure leaf. See `src/apps/direct-tool.ts`.
     */
    tool: z.string().min(1),
    /** Tool parameter name → `$.<declaredArg>` or a literal value. */
    args: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe('Tool parameter name → `$.<declaredArg>` or a literal value'),
  })
  .strict();

/** The manifest form: `args` defaulted, so a parsed dispatch always has one. */
export const ToolDispatchSchema = ToolDispatchFields.extend({
  args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export const AgentDispatchFields = z
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

/** Same shape; named for symmetry with {@link ToolDispatchSchema}. */
export const AgentDispatchSchema = AgentDispatchFields;

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
 * The action fields only a USER may set (#453).
 *
 * These decide what an app is permitted to do, so they are settable at
 * `bernard app allow` and nowhere else — never from the `applet` tool, for the
 * reason `app-grants.ts` gives about a model widening its own authority, and
 * `toolAllowlist` is the stronger of the two controls it would be widening.
 *
 * Written down here, beside the schema that declares them, so the tool's own
 * test can assert its advertised schema names none of them. The set is what
 * makes that assertion possible: without it, "the tool happens not to mention
 * these three strings" is a fact nothing checks.
 */
export const AUTHORITY_ACTION_FIELDS = ['toolAllowlist', 'toolMode', 'confirmMode'] as const;

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

/**
 * One thing an applet asks for, and why (#467, #468).
 *
 * **A declaration is a request, and requests are not authority.** This is the
 * one part of the permission design that has to stay true for the rest of it
 * to be safe: the manifest is written by the `applet` tool — by a model — so
 * nothing here reaches a response header. `src/apps/app-csp-grants.ts` holds
 * what the user actually allowed, and only that is read by `cspFor`. What a
 * declaration buys is that there is something to SHOW the user: without it a
 * permission prompt has nothing to put on screen, and the alternative is the
 * shape #467 originally imagined — a line of prose telling the user to go and
 * type a CLI command, which is homework rather than a request.
 *
 * Android is the precedent and it is exact: the app's manifest declares
 * `<uses-permission>`, the OS asks, the OS stores the answer. It is also what
 * MCP Apps (SEP-1865) already requires of a host — "MUST construct CSP headers
 * based on declared domains; MUST NOT allow undeclared domains" — with Bernard
 * one step stricter, since declared is necessary here and not sufficient.
 *
 * `reason` is model-written prose shown to a user who is about to make a
 * security decision, so it is capped, and every renderer treats it as
 * untrusted: the structural fact (which directive, which origins) is what
 * Bernard states in its own words, and this sentence appears beneath it,
 * escaped and attributed to the applet. Same posture as `<available_sources>`.
 */
const PermissionRequestSchema = z
  .object({
    origins: z
      .array(
        z
          .string()
          .refine(isGrantableSource, 'not an origin a user could grant — scheme://host[:port]'),
      )
      .min(1)
      .max(MAX_SOURCES_PER_DIRECTIVE),
    reason: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * What an applet asks for.
 *
 * Keyed by the same camelCase directive names the grant store uses, so a
 * declaration and a grant are comparable without a translation table that
 * could disagree with itself.
 */
export const AppPermissionsSchema = z
  .object({
    imgSrc: PermissionRequestSchema.optional(),
    connectSrc: PermissionRequestSchema.optional(),
    fontSrc: PermissionRequestSchema.optional(),
    mediaSrc: PermissionRequestSchema.optional(),
    sandbox: z
      .object({
        // Aliases are accepted here — `links` and `navigate` are what a model
        // should be asking for, since the raw tokens are not independently
        // useful and `allow-popups` alone is the trap #468 names.
        tokens: z.array(z.string().min(1).max(64)).min(1).max(4),
        reason: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AppPermissions = z.infer<typeof AppPermissionsSchema>;

/** One feature a manifest uses, and the revision that can express it. */
export interface SchemaVersionDemand {
  readonly version: AppSchemaVersion;
  readonly path: (string | number)[];
  /** Named the way the refusal reads: "`permissions` requires schemaVersion 3". */
  readonly feature: string;
}

/**
 * Every revision this manifest's contents demand, and why.
 *
 * **One function, two consumers, and that is the point.** The rule is that a
 * manifest is read as the version it STATES, so a v3-only field on a v1
 * manifest would make it half-v3 — readable here and rejected wholesale by an
 * older binary, which is the failure the version union exists to avoid rather
 * than to hide. That rule needs a reader (the refinement below, which refuses)
 * and a writer (`src/tools/applet.ts`, which stamps). Written twice they
 * drift, and the drift is invisible: the writer stamps too low and every write
 * is refused, or too high and every applet costs its readability to an older
 * binary for a field it does not use. `manifest.version.test.ts` pins them
 * against each other in both directions.
 *
 * Takes a structural shape rather than a parsed manifest, because the writer
 * calls it on a manifest whose `schemaVersion` is the thing it is deciding.
 */
export function schemaVersionDemands(m: {
  permissions?: unknown;
  actions: Record<string, { dispatch?: unknown; args?: Record<string, ArgSpec> }>;
}): SchemaVersionDemand[] {
  const demands: SchemaVersionDemand[] = [];
  if (m.permissions) {
    demands.push({ version: 3, path: ['permissions'], feature: '`permissions`' });
  }
  for (const [name, action] of Object.entries(m.actions)) {
    if (action.dispatch) {
      demands.push({
        version: 2,
        path: ['actions', name, 'dispatch'],
        feature: '`dispatch`',
      });
    }
    // Read off the type table rather than tested for by name, so a type added
    // later demands its own revision with no case here to remember.
    const { version, because } = argSpecsSince(Object.values(action.args ?? {}));
    if (version > 1 && because) {
      demands.push({
        version: version as AppSchemaVersion,
        path: ['actions', name, 'args'],
        feature: `the \`${because}\` argument type`,
      });
    }
  }
  return demands;
}

/** The lowest revision that can express this manifest. What a writer stamps. */
export function requiredSchemaVersion(m: Parameters<typeof schemaVersionDemands>[0]): number {
  return schemaVersionDemands(m).reduce((v, d) => Math.max(v, d.version), 1);
}

/**
 * A manifest exactly as it sits on disk, validated but **not lifted**.
 *
 * The write side needs this and cannot use {@link AppManifestSchema}, which
 * `.transform`s: `liftAction` moves a v1 action's flat `instructions` /
 * `specialistId` into `dispatch`, so parsing then re-serializing turns a v1
 * manifest into one that its own `schemaVersion` refinement rejects. A writer
 * validates the raw shape and writes the raw shape; readers keep getting the
 * lifted one.
 */
export const RawAppManifestSchema = z
  .object({
    schemaVersion: AppSchemaVersionSchema,
    id: z.string().regex(APP_ID_RE),
    name: z.string().min(1).max(80),
    description: z.string().max(400).optional(),
    /** What the applet asks the user for. Declaring grants nothing. */
    permissions: AppPermissionsSchema.optional(),
    actions: z.record(z.string().regex(ACTION_NAME_RE), RawAppActionSchema),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (Object.keys(m.actions).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'manifest declares no actions' });
    }
    for (const demand of schemaVersionDemands(m)) {
      if (m.schemaVersion >= demand.version) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: demand.path,
        message: `${demand.feature} requires schemaVersion ${demand.version}`,
      });
    }
    for (const [name, action] of Object.entries(m.actions)) {
      intraActionRules(action, ctx, ['actions', name]);
    }
  });

export type RawAppManifest = z.infer<typeof RawAppManifestSchema>;

/** The reader's view: every action lifted into the `dispatch` union. */
export const AppManifestSchema = RawAppManifestSchema.transform((m) => ({
  ...m,
  actions: Object.fromEntries(
    Object.entries(m.actions).map(([name, action]) => [name, liftAction(action)]),
  ),
}));

export type AppManifest = z.output<typeof AppManifestSchema>;

/** Validates a manifest for WRITING — no lift, so what is checked is what lands. */
export function parseRawAppManifest(raw: unknown): ParseResult<RawAppManifest> {
  const parsed = RawAppManifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
  return { ok: true, value: parsed.data };
}

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

/**
 * Builds the Zod schema for one action's arguments and validates a call
 * against it.
 *
 * Validated at read time as well as at write time (complete mediation): the
 * manifest file is user-editable between runs, so validating only on save is a
 * time-of-check/time-of-use gap.
 *
 * Since #588 a value may be nested, and the property that makes that safe is
 * the same one the scalar case rested on: **what reaches a tool is a zod
 * reconstruction of what the manifest declared, not the caller's object.**
 * `z.object().strict()` at every level rebuilds only the declared keys and
 * rejects the rest, so "the caller's object never reaches a tool wholesale" is
 * as true of an element of `edits` as it is of a `path` string.
 */
export function validateActionArgs(
  action: AppAction,
  raw: unknown,
): ParseResult<Record<string, ArgValue>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, spec] of Object.entries(action.args)) {
    shape[name] = buildArgField(spec);
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
