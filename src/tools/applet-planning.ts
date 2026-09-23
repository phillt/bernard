import type { z } from 'zod';
import { passFailureReason, runAppletPass } from './applet-pass.js';
import { capSubagentResult } from './result-cap.js';
import { debugLog } from '../logger.js';
import { plural } from '../text.js';
import { renderIntentLines } from '../apps/brief.js';
import type { AppletBrief } from '../apps/brief.js';
import {
  ArchitectPlanSchema,
  DataPlanSchema,
  InteractionPlanSchema,
  MicrocopyPlanSchema,
  UxPlanSchema,
  controlsOf,
  parseStagePlan,
  type AppletDesign,
} from '../apps/design-model.js';
import { checkDesign, renderDesignIssues } from '../apps/design-checks.js';
import type { StashedPlan } from '../apps/design-stash.js';
import type { AgentContext } from '../framework/context.js';

/**
 * Deciding what an applet should be, before it is built.
 *
 * `interviewPlaybook()` ends with "build the smallest coherent thing" and hands
 * the model no way to work out what that is, so the agent went from the last
 * interview answer straight to writing HTML. Nothing decided what screens
 * exist, what is stored, or which of the two rendering approaches to use — the
 * result was plausible and arbitrary, and structural mistakes surfaced only
 * when a button was clicked.
 *
 * ## Why not the `plan` tool Bernard already has
 *
 * Because they are different kinds of object, and that — not the plumbing — is
 * the reason. A `plan` step is `{description, verification}`: a turn-scoped
 * EXECUTION LEDGER whose every step must reach a terminal state, with `done`
 * requiring a `signoff` attesting the verification was performed. What a planner
 * produces here is a DESIGN SPECIFICATION — scope, controls and states, store
 * keys, dispatch tiers — which outlives the turn, has no verification criterion
 * and nothing to sign off. `enforcePlan` would re-prompt the model to mark "the
 * applet stores readings under `reading:<iso>`" as done. Forcing a spec into a
 * step ledger is the shallower change wearing a deeper one's clothes.
 *
 * There are also mechanical blockers, and they are a FOOTNOTE rather than the
 * argument: `toolWrapperDefinition` constructs a `NormalStrategy` directly
 * instead of calling `buildStrategy`, so neither strategy wrapper can attach;
 * and `dispatchToolWrapper` passes no `planStore`, so `enforcePlan` returns on
 * its first line. Both are two-line fixes. They are recorded so that someone who
 * removes them for unrelated reasons does not conclude this module should be
 * deleted — the category argument above is what keeps it.
 *
 * ## Why this module rather than a line in `applet.ts`
 *
 * The same reason `applet-styling.ts` gives, and it is worth not re-deriving:
 * `dispatchToolWrapper` needs a live {@link AgentContext}, `createTools` is a
 * pure function of its arguments so the main tool block stays byte-identical
 * for the prompt cache, and a CAPTURED ctx is worse than none because
 * `Agent.processInput` re-points `this.ctx` every turn (#332). So the ctx-taking
 * half lives here, `applet.ts` takes a plain callback, and neither imports the
 * other's dependencies.
 *
 * ## Architect first, then the other two in parallel
 *
 * A blind fan-out is the failure this shape exists to avoid: two planners given
 * the same brief and no shared scope plan differently-sized applets, and the
 * contradiction is only discovered by whoever has to write one page from both.
 * The architect decides scope once and both inherit it.
 *
 * The parallel half is bounded deliberately at two. `withSlot` does NOT queue —
 * at the cap it calls `onExhausted` immediately — so a three-way fan-out from
 * inside a main-agent turn would hold three of the four slots and starve
 * anything else the turn wanted to do. Two leaves headroom.
 *
 * ## Fail-open, because a failed plan must never block a build
 *
 * Every degradation returns something. If the architect fails there is no scope
 * to plan against, so the pair do not run and the reason is named; if one of the
 * pair fails, the spec comes back with that section marked missing. The one
 * thing that unwinds is cancellation, which is not a planning failure and must
 * not be reported as one.
 *
 * ## The recursion guard, twice over
 *
 * `createTools` builds `applet` with no planner, so the instance a dispatched
 * specialist holds cannot re-enter this — structurally the same argument
 * `applet-styling.ts` makes, and pinned by the same shape of test. And the three
 * planners declare `targetTools: ['docs']`, so they never hold an `applet` tool
 * at all.
 */

/** What the planning pass produced, as the caller has to render it either way. */
export type PlanOutcome =
  | {
      planned: true;
      spec: string;
      /**
       * The typed model behind the spec, for `create` to persist.
       *
       * Separate from `spec` because they serve different readers: `spec` is
       * prose for the model that writes the page, `design` is the record that
       * outlives the turn. Before this the spec was the only artefact and it
       * was dropped at the end of the turn — after being truncated twice on
       * the way there.
       */
      design: AppletDesign;
      /**
       * Each stage's prose, keyed by its label.
       *
       * Carried out of the run so a later re-plan of ONE stage can splice the
       * others in verbatim, exactly as the first run did. The typed design
       * cannot stand in: the only rendering of it is a summary, so seeding a
       * downstream brief from it hands that stage a shorter, different input
       * than it saw the first time — the paraphrase hazard the verbatim
       * splice exists to prevent.
       */
      bodies: Record<string, string>;
      /** Stages reused from a prior plan rather than re-dispatched. */
      reused: string[];
    }
  | { planned: false; reason: string };

/** What an applet is being planned from — the interview's answers, before it exists. */
export interface PlanTarget {
  /** Display name, or the id, or whatever the user called it. */
  name: string;
  /** One line on what it is for. */
  description: string;
  /** The brief's intent model. Partial by design: an empty field is honest. */
  intent: AppletBrief['intent'];
}

/**
 * Plans one applet. Never throws for a planning failure, and never reports a
 * failure as a success — a caller folds the outcome into its own result.
 * Cancellation is the one thing that propagates.
 */
/** What a caller can vary about one planning run. */
export interface PlanOptions {
  signal?: AbortSignal;
  /**
   * Stage labels to actually run. Absent means all of them.
   *
   * Everything not named is taken from {@link prior}, which is what makes a
   * re-plan of one stage cheap AND faithful — the stages that did not change
   * contribute the same bytes they did the first time.
   */
  only?: string[];
  /**
   * What to do differently, rendered as its own trailing section of every
   * stage this run dispatches — a stage carried over from {@link prior}
   * never sees it. One string, not a per-stage map: "too many buttons, try
   * the controls again" names one change and one stage, and `only` is what
   * names the stage.
   */
  nudge?: string;
  /** A previous run's design and bodies, to build on. */
  prior?: StashedPlan;
}

export type AppletPlanner = (target: PlanTarget, opts?: PlanOptions) => Promise<PlanOutcome>;

// Re-exported from the leaf that owns them, so a reader of the pipeline finds
// its vocabulary here and a module that must not import the pipeline finds it
// there.
import { APPLET_DESIGN_PIPELINE } from '../apps/design-model.js';
export { APPLET_DESIGN_PIPELINE, PLAN_STAGES } from '../apps/design-model.js';
export type { PlanStage } from '../apps/design-model.js';

/** The specialists this routes to. Bundled, so they are always present. */
export const ARCHITECT_SPECIALIST_ID = 'applet-architect';
export const UX_PLANNER_SPECIALIST_ID = 'applet-ux-planner';
export const DATA_PLANNER_SPECIALIST_ID = 'applet-data-planner';
export const INTERACTION_SPECIALIST_ID = 'applet-interaction-designer';
export const MICROCOPY_SPECIALIST_ID = 'applet-microcopy';

/**
 * The brief's intent, rendered for a planner.
 *
 * Delegates which fields are shown, and in what order, to
 * {@link renderIntentLines} — the same helper `renderBrief` uses. Two copies of
 * that rule had already diverged on trimming and on bolding, and the ordering
 * half is load-bearing: two planners reading one brief in different orders is a
 * difference with no meaning.
 */
function renderIntent(intent: AppletBrief['intent']): string {
  const rows = renderIntentLines(intent);
  return rows.length > 0
    ? rows.join('\n')
    : '(nothing recorded — say so rather than inventing one)';
}

/**
 * A caller's extra instruction for one stage, as its own trailing section.
 *
 * Kept OUT of the body of the brief on purpose. Everything above it is either
 * the applet's own facts or a prior stage's verbatim output, and splicing a
 * nudge into those would make "the scope passed down unchanged" false — which
 * is the one property the whole sequencing rests on. At the end, under its own
 * heading, it reads as what it is: the person asking for this plan saying what
 * they want different about it.
 */
function nudgeSection(nudge: string | undefined): string[] {
  const text = nudge?.trim();
  return text ? ['', '## What to change this time', '', text] : [];
}

/** The brief handed to the architect. Carries only the per-applet facts. */
export function buildArchitectBrief(target: PlanTarget, nudge?: string): string {
  return [
    `Decide the scope for an applet called "${target.name}".`,
    '',
    `What it is for: ${target.description || '(not stated)'}`,
    '',
    'What the person said:',
    renderIntent(target.intent),
    ...nudgeSection(nudge),
  ].join('\n');
}

/**
 * The brief handed to the UX and data planners.
 *
 * **Not migrated to `DispatchBrief` (#509), and the reason is a distinction
 * worth keeping.** That type models the parent→child ENVELOPE — the labelled
 * task, the supporting sections, the data channel — and these two functions
 * produce the envelope's `task`, which is where their output already goes. They
 * are a prompt body, not a second envelope format, and forcing their paragraphs
 * into `BriefSection`s would either move their bytes or add a per-paragraph
 * separator knob to a type that currently has one meaningful distinction. What
 * #509 wants from them — the scope passing verbatim — is already true and
 * already tested.
 *
 * Both get the architect's scope VERBATIM rather than a paraphrase. The scope is
 * the only thing making these two agree, so re-wording it per planner is the one
 * edit that would quietly reintroduce the divergence the sequencing prevents.
 */
export function buildPlannerBrief(
  target: PlanTarget,
  scope: string,
  job: string,
  nudge?: string,
): string {
  return [
    `${job} for the applet "${target.name}".`,
    '',
    `What it is for: ${target.description || '(not stated)'}`,
    '',
    'The scope has already been decided. Plan inside it — do not widen it:',
    '',
    scope,
    '',
    'What the person said:',
    renderIntent(target.intent),
    ...nudgeSection(nudge),
  ].join('\n');
}

/**
 * The brief for a stage that reads what earlier stages decided.
 *
 * Every prior body is spliced in VERBATIM, for the reason
 * {@link buildPlannerBrief} already gives about the architect's scope:
 * re-wording it per stage is the one edit that quietly reintroduces the
 * divergence the hierarchy exists to prevent. A stage that failed is named as
 * missing rather than omitted, so a downstream stage knows the difference
 * between "nobody decided this" and "this was decided to be nothing".
 */
export function buildStageBrief(
  target: PlanTarget,
  scope: string,
  priors: Array<[string, Section]>,
  job: string,
  nudge?: string,
): string {
  return [
    `${job} for "${target.name}".`,
    '',
    '## Scope',
    '',
    scope,
    ...priors.flatMap(([title, section]) => [
      '',
      `## ${title}`,
      '',
      section.ok ? section.body : `(not planned — ${section.reason}. Work without it.)`,
    ]),
    ...nudgeSection(nudge),
  ].join('\n');
}

/**
 * One dispatch, reduced to what the assembler needs.
 *
 * `body` is the prose the MODEL is shown; `result` is the raw payload the
 * typed model is parsed from. Both, because parsing is additive: a stage
 * whose shape we did not anticipate still contributes its prose, and only
 * loses its checks.
 */
type Section = { ok: true; body: string; result: unknown } | { ok: false; reason: string };

/**
 * Renders a wrapper result as a section body, bounded.
 *
 * A structured `result` is an object, so it is stringified rather than
 * interpolated — `String({})` is `[object Object]`, which reads as a plausible
 * section and carries nothing. A string result passes through, since a
 * specialist that answered in prose has still answered.
 *
 * ## Why this is capped, when the styler's equivalent is not
 *
 * `dispatchToolWrapper` returns an UNCAPPED `WrapperResult`; the
 * `SUBAGENT_RESULT_MAX_CHARS` cap lives in `renderWrapperParentView`, which only
 * the `tool_wrapper_run` TOOL path calls. `makeAppletStyler` never hit that
 * because it takes `result` only when it is a string and never returns it to the
 * model. This is the first path to route a structured wrapper result straight
 * into a model-visible tool return, and it does so three times in one string.
 *
 * All three planners declare `structuredOutput`, so every body takes the
 * stringify branch, and each can be a full `maxTokens` response — roughly 16 KB
 * compact. Uncapped and pretty-printed, one spec reached an estimated 50-70 KB.
 * Nothing downstream saves it: `truncateToolResults` bounds history at
 * `MAX_TOOL_RESULT_CHARS` on the way IN, so the full payload still sits in
 * context for the rest of the turn, and the next turn sees it chopped
 * mid-token.
 *
 * Compact rather than indented, because indentation is the one part of the
 * payload a model does not need, and on these shapes — arrays of small flat
 * objects — it is 30-40% of the bytes.
 */
function sectionBody(result: unknown): string {
  if (typeof result === 'string') return capSubagentResult(result.trim());
  try {
    return capSubagentResult(JSON.stringify(result));
  } catch {
    return '';
  }
}

/**
 * Parses one stage's payload, and makes a failure VISIBLE.
 *
 * `parseStagePlan(...) ?? undefined` was the whole of this, and it is the
 * quietest bug in the pipeline. A stage can dispatch fine, return prose that
 * lands in the spec, and miss its schema by one field — and the typed stage
 * is then dropped with nothing said. `checkDesign` skips every rule whose
 * stage is absent, by design, so the cross-stage checks do not merely lose
 * that stage: they go silent for the whole design.
 *
 * Measured on a payload that misses by one enum value (`intent: "remove"`,
 * which is not one of the five verbs): the architect is dropped, and a design
 * carrying a destructive control with no confirmation AND a control naming an
 * action nothing declared produces **zero** issues. The spec reads as a clean
 * plan, because the prose is still there.
 *
 * So a drop is recorded rather than swallowed. It is not a stage FAILURE —
 * the prose is real and the model can still build from it — it is the loss of
 * the checks, which is a different fact and needs saying in its own words.
 */
function parseStage<S extends z.ZodTypeAny>(
  label: string,
  schema: S,
  section: Section,
  unparsed: string[],
): z.output<S> | undefined {
  if (!section.ok) return undefined;
  const parsed = parseStagePlan(schema, section.result);
  if (parsed === null) {
    unparsed.push(label);
    debugLog('applet:plan:unparsed', { stage: label });
    return undefined;
  }
  return parsed;
}

async function runPlanner(
  ctx: AgentContext,
  specialistId: string,
  label: string,
  input: string,
  signal?: AbortSignal,
): Promise<Section> {
  const pass = await runAppletPass(ctx, {
    specialistId,
    input,
    runLabel: `[plan] ${label}`,
    // The channel that says this IS the pipeline. Every stage record is
    // marked `pipeline`, so `invocationRefusal` refuses it from anywhere
    // else — which is the whole lock-down, and this one line is what keeps
    // the legitimate caller working. It rides the internal args interface
    // rather than the tool's schema precisely so a model cannot claim it.
    via: { kind: 'pipeline', pipeline: APPLET_DESIGN_PIPELINE },
    signal,
  });
  if (!pass.ok) return { ok: false, reason: pass.reason };
  const body = sectionBody(pass.result);
  // An empty body is a failure wearing a success's clothes. The dispatch
  // returned, so nothing downstream would notice, and the assembled spec
  // would carry a heading with nothing under it.
  return body ? { ok: true, body, result: pass.result } : { ok: false, reason: 'returned no plan' };
}

/** One section of the assembled spec, present or accounted for. */
function renderSection(title: string, section: Section): string {
  return section.ok
    ? `## ${title}\n\n${section.body}`
    : `## ${title}\n\n(not planned — ${section.reason}. Decide this yourself as you build.)`;
}
/**
 * Should the wording pass run?
 *
 * The countable-test idiom `UI_RUNTIME_RULE` already uses, rather than a
 * judgement about whether an applet "needs" better words. A one-button applet
 * has one label and the interaction stage already set it; the pass earns its
 * ~6 s and its uncacheable ~4.4k prompt tokens once there is enough copy for
 * verbosity to accumulate, or once a confirmation exists — a confirmation is
 * where generated wording goes wrong most reliably, and where it costs most.
 */
export function needsMicrocopy(design: AppletDesign): boolean {
  const controls = controlsOf(design);
  if (controls.length > 4) return true;
  return (
    controls.some((c) => c.confirm === true) ||
    (design.architect?.actions ?? []).some((a) => a.intent === 'destroy' || a.risk === 'high')
  );
}

/**
 * Builds the planning callback for one turn's context.
 *
 * ## Large decisions before small ones
 *
 * The architect's own body is what everything downstream plans against, so
 * its failure is the one that stops everything: with no scope the rest would
 * plan differently-sized applets, which is worse than not planning at all.
 *
 * The order is the design, not a pipeline that happened to grow: scope, then
 * shape and storage, then the form each action takes, then the words. You do
 * not want an interaction stage deciding "this needs a trash icon" before
 * something upstream has established that a destructive delete belongs here
 * at all — and that is not hypothetical. On the applet this was built for,
 * the architect scoped five views OUT and the UX planner planned all five,
 * because the only thing carrying the decision downstream was prose.
 *
 * ## The fan-out stays at two
 *
 * `withSlot` does NOT queue — at the cap it calls `onExhausted` immediately —
 * so a three-way fan-out from inside a main-agent turn would hold three of
 * the four slots and starve anything else the turn wanted to do. The two new
 * stages are therefore sequential, which the hierarchy wanted anyway: each
 * reads what the one before it decided.
 */
export function makeAppletPlanner(ctx: AgentContext): AppletPlanner {
  return async (target, opts = {}) => {
    const { signal, only, nudge, prior } = opts;
    const design: AppletDesign = { ...prior?.design };
    /** Each stage's prose, for the spec and for the next re-plan. */
    const bodies: Record<string, string> = { ...prior?.bodies };
    const reused: string[] = [];
    /**
     * Stages that answered, but not in a shape the model could read.
     *
     * Tracked rather than inferred from `design`, because absent-and-ran and
     * absent-and-failed look identical there — and they call for opposite
     * things from the reader. A stage that never ran is already named in its
     * own section; a stage that ran and did not parse looks complete.
     */
    const unparsed: string[] = [];

    /**
     * Runs a stage, or hands back what the prior plan produced for it.
     *
     * Reuse needs BOTH halves — the body, which the next stage splices
     * verbatim, and the typed entry, which the checks read. Re-parsing is not
     * an option because the raw payload is not kept; carrying the prior
     * design entry straight across is, and it is also the truthful thing,
     * since that entry IS what that stage decided.
     *
     * A stage named in `only` always runs. A stage NOT named runs anyway when
     * there is nothing to reuse — otherwise asking to re-plan the controls of
     * a plan that never had a scope would produce a design with a hole in the
     * middle and no way to say so.
     */
    const stage = async (
      label: string,
      specialistId: string,
      brief: (nudge?: string) => string,
      key: keyof AppletDesign,
      schema: Parameters<typeof parseStage>[1],
    ): Promise<Section> => {
      const carried = only && !only.includes(label) ? prior?.bodies[label] : undefined;
      if (carried !== undefined) {
        reused.push(label);
        return { ok: true, body: carried, result: undefined };
      }
      // The nudge reaches a stage the caller ASKED to run, and not one that is
      // running only because there was nothing to carry over: the person
      // said what to change about the controls, not about a scope that has
      // never been planned.
      const nudged = !only || only.includes(label) ? nudge : undefined;
      const section = await runPlanner(ctx, specialistId, label, brief(nudged), signal);
      if (!section.ok) {
        debugLog('applet:plan:error', { name: target.name, stage: label, reason: section.reason });
        // A stage that failed contributes nothing, and must not leave the
        // prior run's answer in place wearing this run's authority.
        delete design[key];
        return section;
      }
      bodies[label] = section.body;
      design[key] = parseStage(label, schema, section, unparsed) as never;
      return section;
    };

    try {
      const architect = await stage(
        'scope',
        ARCHITECT_SPECIALIST_ID,
        (n) => buildArchitectBrief(target, n),
        'architect',
        ArchitectPlanSchema,
      );
      if (!architect.ok) {
        return { planned: false, reason: `scope could not be decided (${architect.reason})` };
      }

      const [ux, data] = await Promise.all([
        stage(
          'interface',
          UX_PLANNER_SPECIALIST_ID,
          (n) => buildPlannerBrief(target, architect.body, 'Plan the interface', n),
          'ux',
          UxPlanSchema,
        ),
        stage(
          'data and actions',
          DATA_PLANNER_SPECIALIST_ID,
          (n) => buildPlannerBrief(target, architect.body, 'Plan the data and actions', n),
          'data',
          DataPlanSchema,
        ),
      ]);

      // The form each action takes, decided from what the action MEANS. Needs
      // the scope's semantics and the layout, so it cannot run beside them.
      const interaction = await stage(
        'controls',
        INTERACTION_SPECIALIST_ID,
        (n) =>
          buildStageBrief(target, architect.body, [['Interface', ux]], 'Decide the controls', n),
        'interaction',
        InteractionPlanSchema,
      );

      let microcopy: Section | null = null;
      if (needsMicrocopy(design)) {
        microcopy = await stage(
          'wording',
          MICROCOPY_SPECIALIST_ID,
          (n) =>
            buildStageBrief(
              target,
              architect.body,
              [
                ['Interface', ux],
                ['Controls', interaction],
              ],
              'Write the words',
              n,
            ),
          'microcopy',
          MicrocopyPlanSchema,
        );
      }

      // Everything decidable by arithmetic, before the model reads a word of
      // it. A control naming an action the scope never declared is the one
      // this exists for.
      const issues = checkDesign(design);
      debugLog('applet:plan:checked', {
        name: target.name,
        refusals: issues.filter((i) => i.level === 'refuse').length,
        warnings: issues.filter((i) => i.level === 'warn').length,
        stages: Object.keys(design),
        microcopy: microcopy !== null,
        unparsed,
      });

      const sections = [
        renderSection('Scope', architect),
        renderSection('Interface', ux),
        renderSection('Data and actions', data),
        renderSection('Controls', interaction),
        ...(microcopy ? [renderSection('Wording', microcopy)] : []),
      ];
      const problems = renderDesignIssues(issues);
      /**
       * The checks that could not run, said in the spec rather than only in a
       * debug log nobody has enabled.
       *
       * This reads as a caveat and is closer to a warning: `checkDesign`
       * skips every rule whose stage is missing, so ONE unparsed stage can
       * take the cross-stage rules down for the whole design — a control
       * naming an action the scope never declared goes uncaught, which is the
       * single thing this pipeline was rebuilt to catch. The reader needs to
       * know the plan was not checked, not merely that a stage is thin.
       */
      const unchecked =
        unparsed.length > 0
          ? `The ${unparsed.join(' and ')} ${plural(unparsed.length, 'stage', 'stages')} answered ` +
            'in a shape that could not be read, so the automatic checks did not run against ' +
            `${plural(unparsed.length, 'it', 'them')}. Read the ${plural(unparsed.length, 'section', 'sections')} ` +
            'above yourself before building.'
          : '';

      return {
        planned: true,
        design,
        bodies,
        reused,
        spec: [
          `# Build plan for "${target.name}"`,
          '',
          sections.join('\n\n'),
          ...(problems || unchecked
            ? [
                '',
                '## Problems found in this plan',
                '',
                ...(unchecked ? [unchecked, ...(problems ? [''] : [])] : []),
                ...(problems ? [problems] : []),
              ]
            : []),
          '',
          '---',
          '',
          'Build this. Where a section is missing, decide it yourself rather than',
          'widening the scope to cover it.',
          ...(problems
            ? ['Fix everything under "Problems found in this plan" before you build.']
            : []),
        ].join('\n'),
      };
    } catch (err) {
      // A cancelled turn is not a planning failure and must not be reported as
      // one. The caller says "not planned" and the build is still available.
      const reason = passFailureReason(err);
      debugLog('applet:plan:error', { name: target.name, stage: 'dispatch', reason });
      return { planned: false, reason };
    }
  };
}
