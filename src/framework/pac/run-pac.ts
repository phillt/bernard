import { definitions } from '../agents/registry.js';
import { runDefinition, type RunDefinitionOpts } from '../agents/run.js';
import type { AgentContext } from '../context.js';
import type { PacPlannerInput } from '../agents/pac-planner.js';
import type { PacActorInput } from '../agents/pac-actor.js';
import type { PacCriticInput, PacCriticVerdict } from '../agents/pac-critic.js';
import { capSubagentResult, SUBAGENT_RESULT_MAX_CHARS } from '../../tools/result-cap.js';

/**
 * Maximum number of retry cycles after a Critic FAIL verdict. Each retry runs
 * Planner (with prior plan + critic feedback) and then Actor + Critic again.
 *
 * `0` would disable retries; `1` means worst case: 2 planner runs, 2 actor
 * runs, 2 critic runs per PAC invocation.
 */
export const PAC_MAX_RETRIES = 1;

/** Inputs accepted by {@link runPAC}. Mirrors the SubAgentInput payload. */
export interface PacRunInput {
  task: string;
  context?: string;
  slotId: number;
}

/** Outcome of one PAC pipeline invocation. */
export interface PacRunResult {
  /** The (possibly footer-augmented) Actor output passed back to the caller. */
  formatted: string;
  /**
   * Final critic verdict at the end of the pipeline. `'warn'` means the
   * pipeline completed without retrying — caveats are surfaced in `formatted`
   * via a `## Critic Verdict: WARN` footer.
   */
  verdict: 'pass' | 'warn' | 'fail';
  /** Critic's reason for the final verdict. */
  reason: string;
  /** How many retry cycles were used (0 = single pass). */
  retries: number;
}

/**
 * Run the three-agent PAC (Planner → Actor → Critic) pipeline.
 *
 * Phase isolation: each phase is a distinct {@link AgentDefinition} with its
 * own system prompt, tool set, and ephemeral history. Outputs flow forward as
 * plain strings — phases do not share LLM history.
 *
 * Retry policy: on Critic verdict `fail` with retry budget remaining, the
 * pipeline re-runs the Planner with the prior plan + critic feedback, then
 * re-runs the Actor against the revised plan. After {@link PAC_MAX_RETRIES}
 * failures, the pipeline returns the Actor's last output with a critic-warning
 * footer so the caller (main agent) can see verification failed.
 */
export async function runPAC(
  ctx: AgentContext,
  input: PacRunInput,
  opts: RunDefinitionOpts = {},
): Promise<PacRunResult> {
  const plannerDef = definitions.get<PacPlannerInput, string>('pac-planner');
  const actorDef = definitions.get<PacActorInput, string>('pac-actor');
  const criticDef = definitions.get<PacCriticInput, PacCriticVerdict>('pac-critic');

  let plan = (
    await runDefinition(
      ctx,
      plannerDef,
      { task: input.task, context: input.context, slotId: input.slotId },
      opts,
    )
  ).formatted;

  let actorOutput = '';
  let verdict: PacCriticVerdict = {
    verdict: 'fail',
    reason: 'critic not yet run',
    raw: '',
  };

  for (let attempt = 0; attempt <= PAC_MAX_RETRIES; attempt++) {
    actorOutput = (
      await runDefinition(
        ctx,
        actorDef,
        {
          task: input.task,
          context: input.context,
          plan,
          slotId: input.slotId,
        },
        opts,
      )
    ).formatted;

    verdict = (
      await runDefinition(
        ctx,
        criticDef,
        {
          task: input.task,
          context: input.context,
          plan,
          actorOutput,
          slotId: input.slotId,
        },
        opts,
      )
    ).formatted;

    if (verdict.verdict === 'pass') {
      return {
        formatted: capSubagentResult(actorOutput),
        verdict: 'pass',
        reason: verdict.reason,
        retries: attempt,
      };
    }

    if (verdict.verdict === 'warn') {
      // Warn means "completed but with caveats" — surface the caveat as a
      // footer but do not retry. Reserve footer space inside the cap so the
      // signal isn't truncated away.
      const warnFooter = `\n\n## Critic Verdict: WARN\n${verdict.reason}`;
      const warnBudget = Math.max(0, SUBAGENT_RESULT_MAX_CHARS - warnFooter.length);
      return {
        formatted: capSubagentResult(actorOutput, warnBudget) + warnFooter,
        verdict: 'warn',
        reason: verdict.reason,
        retries: attempt,
      };
    }

    if (attempt < PAC_MAX_RETRIES) {
      plan = (
        await runDefinition(
          ctx,
          plannerDef,
          {
            task: input.task,
            context: input.context,
            slotId: input.slotId,
            priorPlan: plan,
            criticFeedback: verdict.reason,
          },
          opts,
        )
      ).formatted;
    }
  }

  // Build the FAIL footer first so we can reserve space for it inside the
  // SUBAGENT_RESULT_MAX_CHARS budget. Otherwise an actor output at the cap
  // would push the footer past the cap and downstream capping would silently
  // truncate the FAIL signal away.
  const footer = `\n\n## Critic Verdict: FAIL\n${verdict.reason}`;
  const bodyBudget = Math.max(0, SUBAGENT_RESULT_MAX_CHARS - footer.length);
  const cappedBody = capSubagentResult(actorOutput, bodyBudget);
  return {
    formatted: cappedBody + footer,
    verdict: 'fail',
    reason: verdict.reason,
    retries: PAC_MAX_RETRIES,
  };
}
