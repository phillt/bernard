import { dispatchToolWrapper } from './tool-wrapper-run.js';
import { isDispatchCancellation } from '../error-taxonomy.js';
import { capSubagentResult } from './result-cap.js';
import { debugLog } from '../logger.js';
import { renderIntentLines } from '../apps/brief.js';
import type { AppletBrief } from '../apps/brief.js';
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
export type PlanOutcome = { planned: true; spec: string } | { planned: false; reason: string };

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
export type AppletPlanner = (target: PlanTarget, signal?: AbortSignal) => Promise<PlanOutcome>;

/** The specialists this routes to. Bundled, so they are always present. */
export const ARCHITECT_SPECIALIST_ID = 'applet-architect';
export const UX_PLANNER_SPECIALIST_ID = 'applet-ux-planner';
export const DATA_PLANNER_SPECIALIST_ID = 'applet-data-planner';

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

/** The brief handed to the architect. Carries only the per-applet facts. */
export function buildArchitectBrief(target: PlanTarget): string {
  return [
    `Decide the scope for an applet called "${target.name}".`,
    '',
    `What it is for: ${target.description || '(not stated)'}`,
    '',
    'What the person said:',
    renderIntent(target.intent),
  ].join('\n');
}

/**
 * The brief handed to the UX and data planners.
 *
 * Both get the architect's scope VERBATIM rather than a paraphrase. The scope is
 * the only thing making these two agree, so re-wording it per planner is the one
 * edit that would quietly reintroduce the divergence the sequencing prevents.
 */
export function buildPlannerBrief(target: PlanTarget, scope: string, job: string): string {
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
  ].join('\n');
}

/** One dispatch, reduced to the two things the assembler needs. */
type Section = { ok: true; body: string } | { ok: false; reason: string };

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

async function runPlanner(
  ctx: AgentContext,
  specialistId: string,
  label: string,
  input: string,
  signal?: AbortSignal,
): Promise<Section> {
  const wrapped = await dispatchToolWrapper(
    {
      specialistId,
      input,
      runLabel: `[plan] ${label}`,
      // Not optional. These are `kind: 'tool-wrapper'`, which is exactly the
      // shape `dispatchToolWrapper` enqueues a correction candidate for, and
      // `permissionsFor` grants bundled records `canAppendExamples: true` — so
      // the queue really can reach and teach a frozen record. A planner that
      // lost a pool slot is not a call-shape mistake.
      skipCorrectionEnqueue: true,
      // Per CALL, not per construction: the tool is built once a turn but the
      // signal belongs to the invocation.
      ...(signal ? { abortSignal: signal } : {}),
    },
    ctx,
  );
  if (wrapped.status === 'ok') {
    const body = sectionBody(wrapped.result);
    // An empty body is a failure wearing a success's clothes. The dispatch
    // returned, so nothing downstream would notice, and the assembled spec
    // would carry a heading with nothing under it.
    return body ? { ok: true, body } : { ok: false, reason: 'returned no plan' };
  }
  // `error` is the code (`pool_exhausted`, `no_api_key`, `step_limit`);
  // `result` is the human message. The code is what a reader acts on.
  return { ok: false, reason: wrapped.error ?? String(wrapped.result ?? 'unknown') };
}

/** One section of the assembled spec, present or accounted for. */
function renderSection(title: string, section: Section): string {
  return section.ok
    ? `## ${title}\n\n${section.body}`
    : `## ${title}\n\n(not planned — ${section.reason}. Decide this yourself as you build.)`;
}

/**
 * Builds the planning callback for one turn's context.
 *
 * The architect's own body is what the pair plan against, so its failure is the
 * one that stops everything: with no scope the two would plan
 * differently-sized applets, which is worse than not planning at all.
 */
export function makeAppletPlanner(ctx: AgentContext): AppletPlanner {
  return async (target, signal) => {
    try {
      const architect = await runPlanner(
        ctx,
        ARCHITECT_SPECIALIST_ID,
        'scope',
        buildArchitectBrief(target),
        signal,
      );
      if (!architect.ok) {
        debugLog('applet:plan:error', {
          name: target.name,
          stage: 'architect',
          reason: architect.reason,
        });
        return { planned: false, reason: `scope could not be decided (${architect.reason})` };
      }

      const [ux, data] = await Promise.all([
        runPlanner(
          ctx,
          UX_PLANNER_SPECIALIST_ID,
          'interface',
          buildPlannerBrief(target, architect.body, 'Plan the interface'),
          signal,
        ),
        runPlanner(
          ctx,
          DATA_PLANNER_SPECIALIST_ID,
          'data',
          buildPlannerBrief(target, architect.body, 'Plan the data and actions'),
          signal,
        ),
      ]);

      if (!ux.ok)
        debugLog('applet:plan:error', { name: target.name, stage: 'ux', reason: ux.reason });
      if (!data.ok)
        debugLog('applet:plan:error', { name: target.name, stage: 'data', reason: data.reason });

      return {
        planned: true,
        spec: [
          `# Build plan for "${target.name}"`,
          '',
          renderSection('Scope', architect),
          '',
          renderSection('Interface', ux),
          '',
          renderSection('Data and actions', data),
          '',
          '---',
          '',
          'Build this. Where a section is missing, decide it yourself rather than',
          'widening the scope to cover it.',
        ].join('\n'),
      };
    } catch (err) {
      // A cancelled turn is not a planning failure and must not be reported as
      // one. The caller says "not planned" and the build is still available.
      const reason = isDispatchCancellation(err)
        ? 'cancelled'
        : err instanceof Error
          ? err.message
          : String(err);
      debugLog('applet:plan:error', { name: target.name, stage: 'dispatch', reason });
      return { planned: false, reason };
    }
  };
}
