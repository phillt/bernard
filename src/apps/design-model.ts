import { z } from 'zod';

/**
 * The name every stage record declares, and the name the pipeline claims when
 * it dispatches one.
 *
 * Lives in this leaf rather than beside the pipeline because THREE modules
 * need it and one of them cannot import the pipeline: `tool-wrapper-run.ts`
 * builds the driver's tool through a deferred import precisely so the
 * planner's graph does not reach every dispatch, and a literal `'applet-design'`
 * there was a second spelling of a name that renaming the pipeline would not
 * have reached — the driver would silently have received no tool.
 * `bundled-manifest.test.ts` walks the five records to it, the
 * record-to-constant direction.
 */
export const APPLET_DESIGN_PIPELINE = 'applet-design';

/**
 * The stage labels, in the order they run.
 *
 * The vocabulary a caller re-runs with, so every tool description names them
 * from here rather than restating a list that could drift from the one the
 * pipeline actually dispatches.
 */
export const PLAN_STAGES = [
  'scope',
  'interface',
  'data and actions',
  'controls',
  'wording',
] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];

/**
 * The shared design model the applet planners hand between each other.
 *
 * Before this, every stage's output shape existed **only as prose inside its
 * own system prompt**. Grepping `singleJob|outOfScope|firstPaint|storeKeys`
 * across `src/` returned zero non-test hits: `WrapperResultSchema` types the
 * payload `z.any()`, so nothing checked that `rendering` was one of the two
 * values it is allowed to be, and nothing could compare one stage's output
 * against another's.
 *
 * ## What that cost, measured
 *
 * On the `ai-systems-feed` applet built on this machine, `applet-architect`
 * put "multiple views (new/read/stored/bookmarked/history)" in `outOfScope`
 * with the reason "five states turns it into a full reader app". The UX
 * planner then planned all five, and the shipped page has them. The scope was
 * passed down VERBATIM — `buildPlannerBrief` splices the architect's body in
 * unchanged precisely so it cannot be paraphrased away — and the planner
 * ignored it anyway, because prose cannot refuse.
 *
 * So the constraint that matters here is one line: a {@link Control} names an
 * `actionId`, and that id must resolve in the architect's `actions`. Planning
 * a control for work that was scoped out stops being stylistic drift and
 * becomes a validation error.
 *
 * ## This is NOT the deferred `Specialist.outputSchema`
 *
 * `dispatch-profile.ts` holds that field out on the rule that "a declarable
 * field with nothing enforcing it is a lie on disk". Nothing here is
 * declarable on a record: the enforcer is local and concrete —
 * `applet-planning.ts` parses each planner's `result` against the matching
 * schema below. It needs no new machinery either, because
 * `parseStructuredOutput` already takes a schema and the applet path simply
 * passes `z.any()` today.
 *
 * ## Parsing is additive, never subtractive
 *
 * A stage's prose body is still what the model is shown. These schemas exist
 * to CHECK and to PERSIST, so a planner that returns an extra field loses
 * nothing and a planner that returns an unparseable one degrades to exactly
 * today's behaviour. Zod strips unknown keys rather than rejecting, and every
 * caller treats a parse failure as "no checks available for this stage"
 * rather than "this stage failed" — the fail-open rule the whole planning
 * module is built on.
 */

/** What an action IS, as opposed to how it is presented. The architect's call. */
const ActionIntentSchema = z.enum(['create', 'read', 'update', 'execute', 'destroy']);
const ImportanceSchema = z.enum(['primary', 'secondary', 'tertiary']);
const FrequencySchema = z.enum(['high', 'medium', 'low']);
const RiskSchema = z.enum(['low', 'medium', 'high']);

/**
 * The semantic role of one thing the applet can do.
 *
 * Every downstream presentation decision is a consequence of these five
 * fields, which is the whole reason they are decided once, upstream, by the
 * stage that owns scope. A trash icon is not a choice about iconography; it
 * is what `intent: 'destroy'` looks like.
 */
export const ActionSemanticsSchema = z.object({
  /** Stable within one design. Referenced by {@link ControlSchema.actionId}. */
  id: z.string().min(1),
  intent: ActionIntentSchema,
  importance: ImportanceSchema,
  frequency: FrequencySchema,
  risk: RiskSchema,
  /** Can the person undo it? Decides whether a confirmation is warranted. */
  reversible: z.boolean(),
});
export type ActionSemantics = z.infer<typeof ActionSemanticsSchema>;

/** Rendering approach. Two values, which is what `UI_RUNTIME_RULE` decides between. */
const RenderingSchema = z.enum(['plain', 'runtime']);

/**
 * One control on the page, after the interaction stage has decided its form.
 *
 * `actionId` is nullable because a real control can drive local state rather
 * than an action — a view switch, a filter. That is a legitimate shape and
 * making it unrepresentable would push planners into inventing fake actions
 * to describe it, which is worse than allowing the null.
 */
export const ControlSchema = z.object({
  /** Null for a control that changes local state rather than calling an action. */
  actionId: z.string().min(1).nullable(),
  /** The element, in the floor's vocabulary: `button`, `input`, `select`, … */
  component: z.string().min(1),
  /** `primary` | `secondary` | `danger`, matching `button` / `.secondary` / `.danger`. */
  variant: z.enum(['primary', 'secondary', 'danger']).optional(),
  label: z.string().optional(),
  icon: z.string().optional(),
  iconSize: z.enum(['sm', 'md', 'lg']).optional(),
  /** Required when a control has an icon and no label — see `design-checks.ts`. */
  iconTitle: z.string().optional(),
  /** Where it sits: a region name the layout stage named. */
  placement: z.string().optional(),
  /** Does pressing it ask first? */
  confirm: z.boolean().optional(),
});
export type Control = z.infer<typeof ControlSchema>;

/** What the architect decides. Scope, and the semantic action set. */
export const ArchitectPlanSchema = z.object({
  singleJob: z.string().min(1),
  input: z.string().optional(),
  output: z.string().optional(),
  outOfScope: z.array(z.object({ item: z.string(), why: z.string().optional() })).optional(),
  /**
   * The action set, and the reason this stage owns it: scope and "what can
   * this do" are the same decision, and splitting them is what let a
   * downstream planner add five views.
   */
  actions: z.array(ActionSemanticsSchema).optional(),
  needsStore: z.boolean().optional(),
  needsAgent: z.boolean().optional(),
});

/** What the UX planner decides: shape and sequence, not affordance. */
export const UxPlanSchema = z.object({
  goal: z.string().optional(),
  firstPaint: z.string().optional(),
  rendering: RenderingSchema.optional(),
  renderingWhy: z.string().optional(),
  flow: z
    .array(
      z.object({
        step: z.union([z.string(), z.number()]).optional(),
        shows: z.string().optional(),
        doing: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * The UX planner still names the controls it needs — it is the stage that
   * knows how many there are, which is what `UI_RUNTIME_RULE` counts. What it
   * no longer decides is their FORM; the interaction stage fills in variant,
   * icon and confirmation.
   */
  controls: z.array(ControlSchema.partial({ component: true })).optional(),
  states: z
    .array(
      z.object({
        action: z.string().optional(),
        empty: z.string().optional(),
        loading: z.string().optional(),
        error: z.string().optional(),
        success: z.string().optional(),
      }),
    )
    .optional(),
});

/** What the data planner decides. */
export const DataPlanSchema = z.object({
  storeKeys: z
    .array(z.object({ key: z.string(), holds: z.string().optional(), why: z.string().optional() }))
    .optional(),
  actions: z
    .array(
      z.object({
        name: z.string(),
        tier: z.string().optional(),
        dispatch: z.string().optional(),
        needsTools: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  pageOnly: z.array(z.object({ what: z.string(), why: z.string().optional() })).optional(),
});

/** What the interaction stage decides: the form every action takes. */
export const InteractionPlanSchema = z.object({
  controls: z.array(ControlSchema),
  /** Why a control got the variant it did. One line each, for the critic. */
  rationale: z.array(z.string()).optional(),
});

/** What the microcopy stage decides: the words, everywhere they appear. */
export const MicrocopyPlanSchema = z.object({
  /** Button and field labels, keyed by the control's action id or label. */
  labels: z.array(z.object({ for: z.string(), text: z.string() })).optional(),
  /** Empty / error / success wording per action. */
  states: z
    .array(
      z.object({
        action: z.string().optional(),
        empty: z.string().optional(),
        error: z.string().optional(),
        success: z.string().optional(),
      }),
    )
    .optional(),
  /** Title and body for each confirmation, plus its two button labels. */
  confirmations: z
    .array(
      z.object({
        for: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        confirmLabel: z.string().optional(),
        cancelLabel: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * The assembled design, as persisted alongside the applet.
 *
 * Every stage is optional because every stage can fail open. A design with
 * only a scope is a truthful record of a planning run where everything after
 * the architect fell over, and is strictly more than the nothing that is
 * persisted today.
 */
export const AppletDesignSchema = z.object({
  architect: ArchitectPlanSchema.optional(),
  ux: UxPlanSchema.optional(),
  data: DataPlanSchema.optional(),
  interaction: InteractionPlanSchema.optional(),
  microcopy: MicrocopyPlanSchema.optional(),
});
export type AppletDesign = z.infer<typeof AppletDesignSchema>;

/**
 * Parses one stage's `result` payload, or answers `null`.
 *
 * `null` means "no checks available for this stage", never "this stage
 * failed". The prose body is rendered for the model either way, so a planner
 * that answers in a shape we did not anticipate degrades to exactly the
 * behaviour that shipped before this module existed.
 */
export function parseStagePlan<S extends z.ZodTypeAny>(
  schema: S,
  result: unknown,
): z.output<S> | null {
  const parsed = schema.safeParse(result);
  return parsed.success ? (parsed.data as z.output<S>) : null;
}

/** Every control across the design, in the order a reader meets them. */
export function controlsOf(design: AppletDesign): Control[] {
  if (design.interaction) return design.interaction.controls;
  // Before the interaction stage runs — or when it failed — the UX planner's
  // partial controls are still worth checking what can be checked of them.
  return (design.ux?.controls ?? []).map((c) => ({ ...c, component: c.component ?? 'button' }));
}

/** The declared action set, which is the architect's and nobody else's. */
export function actionsOf(design: AppletDesign): ActionSemantics[] {
  return design.architect?.actions ?? [];
}

/**
 * The design as lines, for the reviewer and for whoever edits next.
 *
 * A SUMMARY, not the whole record: the point is to answer "what was this
 * supposed to be?" in a form a reader can check a page against. Rendering the
 * full model would put a second copy of the spec in front of a model that
 * already has the page, and the spec is the bigger of the two.
 *
 * The action set first, because every control is a consequence of it, and
 * each control on one line so a reader can go down the list against the page.
 */
export function renderDesignLines(design: AppletDesign): string[] {
  const lines: string[] = [];
  const actions = actionsOf(design);
  if (design.architect?.singleJob) lines.push(`**Single job:** ${design.architect.singleJob}`);
  for (const item of design.architect?.outOfScope ?? []) {
    lines.push(`**Out of scope:** ${item.item}${item.why ? ` — ${item.why}` : ''}`);
  }
  if (actions.length > 0) {
    lines.push('', '**Actions**');
    for (const a of actions) {
      lines.push(
        `- \`${a.id}\` — ${a.intent}, ${a.importance}, ${a.frequency} frequency, ` +
          `${a.risk} risk, ${a.reversible ? 'reversible' : 'NOT reversible'}`,
      );
    }
  }
  const controls = controlsOf(design);
  if (controls.length > 0) {
    lines.push('', '**Controls**');
    for (const c of controls) {
      const bits = [
        c.label ?? c.icon ?? '(unlabelled)',
        c.actionId ? `→ \`${c.actionId}\`` : '(local state)',
        c.variant,
        c.icon ? `icon ${c.icon}${c.iconSize ? ` ${c.iconSize}` : ''}` : undefined,
        c.confirm ? 'confirms' : undefined,
        c.placement,
      ].filter(Boolean);
      lines.push(`- ${bits.join(' · ')}`);
    }
  }
  if (design.ux?.rendering) {
    lines.push(
      '',
      `**Rendering:** ${design.ux.rendering}${design.ux.renderingWhy ? ` — ${design.ux.renderingWhy}` : ''}`,
    );
  }
  return lines;
}
