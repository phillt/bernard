import { definitions } from '../agents/registry.js';
import { runDefinition, type RunDefinitionOpts } from '../agents/run.js';
import type { AgentContext } from '../context.js';
import type {
  PacPlannerInput,
} from '../agents/pac-planner.js';
import type { PacActorInput } from '../agents/pac-actor.js';
import type { PacCriticInput, PacCriticVerdict } from '../agents/pac-critic.js';

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
  /** Final critic verdict at the end of the pipeline. */
  verdict: 'pass' | 'fail';
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
        formatted: actorOutput,
        verdict: 'pass',
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

  const footer = `\n\n## Critic Verdict: FAIL\n${verdict.reason}`;
  return {
    formatted: actorOutput + footer,
    verdict: 'fail',
    reason: verdict.reason,
    retries: PAC_MAX_RETRIES,
  };
}
