import type { CoreMessage } from 'ai';
import {
  REACT_AUTO_CANCEL_NOTE,
  REACT_ENFORCEMENT_MAX_RETRIES,
  buildEnforcementFeedback,
  buildMissingPlanFeedback,
  computePlanNeeds,
  shouldEnforcePlan,
} from '../../react.js';
import { truncateToolResults } from '../../context.js';
import { printInfo, printWarning } from '../../output.js';
import { debugLog } from '../../logger.js';
import type { PlanStore } from '../../plan-store.js';
import type { AgentResult } from '../runner.js';
import type { StrategyContext } from './types.js';

/** Inputs for {@link enforcePlan}. */
export interface PlanEnforcementOpts {
  ctx: StrategyContext;
  planStore: PlanStore;
  /** Result of the strategy's own loop; re-prompts build on its messages. */
  result: AgentResult;
  /**
   * Also re-prompt when NO plan exists at all. ReAct passes `true` (the
   * coordinator prompt mandates planning); Normal passes `false`, because
   * nagging a turn that never needed a plan into making one is a cost with no
   * benefit — see {@link computePlanNeeds}.
   */
  enforceMissingPlan: boolean;
  /**
   * Appended to the system prompt on each re-prompt. ReAct passes the
   * coordinator prompt so the re-prompt lands in the same frame as the turn it
   * is correcting. Normal passes nothing on purpose: injecting several KB of
   * coordinator instructions into a turn the qualifier deliberately routed to
   * Normal is a per-call cost, and the feedback message is self-contained.
   */
  systemSuffix?: string;
  /** Per-re-prompt step budget. Undefined → the runner's base budget. */
  enforcementMaxSteps?: number;
}

/**
 * Re-prompts the model to bring its plan to a fully terminal state, then
 * force-cancels whatever is left.
 *
 * Extracted from `ReActStrategy` (#303) so reconciliation can run on Normal
 * turns too. The `plan` tool is mounted in every mode — the main agent's tool
 * block is the prompt-cache prefix and has to stay byte-stable — so before this
 * split a Normal turn could build a plan that nothing held it to. Two turns in
 * one observed session did exactly that: one left a step `in_progress`, the
 * other created a plan and never touched it again.
 *
 * Bounded by {@link REACT_ENFORCEMENT_MAX_RETRIES}; every exit path leaves the
 * plan terminal, either because the model resolved it or because
 * `cancelAllUnresolved` did.
 */
export async function enforcePlan(opts: PlanEnforcementOpts): Promise<AgentResult> {
  const { ctx, planStore, enforceMissingPlan, systemSuffix, enforcementMaxSteps } = opts;
  let result = opts.result;

  // Trivial-turn escape hatch: a turn that answered without touching a single
  // tool AND never created a plan had nothing to coordinate — re-prompting
  // "create a plan" would burn up to REACT_ENFORCEMENT_MAX_RETRIES extra LLM
  // calls on greetings and one-line answers.
  const usedTools = (result.steps ?? []).some((s) => (s.toolCalls?.length ?? 0) > 0);
  const { needsReconcile, needsPlanCreation } = computePlanNeeds({
    planStepCount: planStore.view().length,
    unresolvedCount: planStore.unresolvedCount(),
    usedTools,
  });

  if (
    !shouldEnforcePlan({
      reactMode: enforceMissingPlan,
      aborted: ctx.abortSignal?.aborted === true,
      stepLimitHit: ctx.getStepLimitHit?.() === true,
      needsReconcile,
      needsPlanCreation,
    })
  ) {
    return result;
  }

  const prefixTag = ctx.prefix ? `[${ctx.prefix}] ` : '';
  // A missing plan only counts as unfinished when this caller enforces it;
  // otherwise the loop would spin on a Normal turn that legitimately has none.
  const isUnfinished = (): boolean =>
    planStore.unresolvedCount() > 0 || (enforceMissingPlan && planStore.view().length === 0);

  let attempts = 0;
  while (isUnfinished() && attempts < REACT_ENFORCEMENT_MAX_RETRIES) {
    if (ctx.abortSignal?.aborted) break;
    attempts++;
    const planMissing = planStore.view().length === 0;
    printWarning(
      planMissing
        ? `${prefixTag}Coordinator turn ended without a plan. Prompting to create one... (${attempts}/${REACT_ENFORCEMENT_MAX_RETRIES})`
        : `${prefixTag}Plan has ${planStore.unresolvedCount()} unresolved step(s). Prompting to resolve... (${attempts}/${REACT_ENFORCEMENT_MAX_RETRIES})`,
    );

    const feedback = planMissing
      ? buildMissingPlanFeedback()
      : buildEnforcementFeedback(planStore.render());
    const enforcementExtra: CoreMessage[] = [
      ...truncateToolResults(result.response.messages as CoreMessage[]),
      { role: 'user', content: feedback },
    ];

    try {
      result = await ctx.iterate({
        extra: enforcementExtra,
        systemSuffix,
        maxStepsOverride: enforcementMaxSteps,
      });
    } catch (err) {
      debugLog('react:enforcement-error', err instanceof Error ? err.message : String(err));
      break;
    }
  }

  if (!planStore.isComplete()) {
    const cancelled = planStore.cancelAllUnresolved(REACT_AUTO_CANCEL_NOTE);
    if (cancelled > 0) {
      printInfo(
        `${prefixTag}Auto-cancelled ${cancelled} unresolved plan step(s) after enforcement retries.`,
      );
    }
  } else if (
    enforceMissingPlan &&
    planStore.view().length === 0 &&
    attempts >= REACT_ENFORCEMENT_MAX_RETRIES
  ) {
    // `isComplete()` is vacuously true for an empty plan, so the give-up notice
    // for a never-created plan needs its own branch.
    printInfo(
      `${prefixTag}Coordinator turn finished without a plan after ${REACT_ENFORCEMENT_MAX_RETRIES} re-prompt(s).`,
    );
  }

  return result;
}
