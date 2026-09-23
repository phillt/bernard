import { passFailureReason, runAppletPass } from './applet-pass.js';
import { debugLog } from '../logger.js';
import { renderIntentLines } from '../apps/brief.js';
import type { PlanTarget, PlanStage } from './applet-planning.js';
import type { AgentContext } from '../framework/context.js';

/**
 * Routing the agent that DRIVES the design pipeline.
 *
 * The pipeline is code and stays code — the sequence, the briefs, the schema
 * parsing, the cross-stage checks and the result caps are all things a model
 * orchestrator would lose. What it does not decide is *which* stage to re-run
 * and with what nudge, and that is judgement.
 *
 * It lives in a record rather than in the main agent because the main agent's
 * prompt carries the whole product, which is how it came to improvise its own
 * version of this pipeline rather than calling it. A record whose entire
 * system prompt is how to build an applet well has a better chance, and this
 * is the user's own argument for the shape.
 *
 * Everything else here is `applet-styling.ts`'s, for the reasons that module
 * states: the ctx-taking half lives outside `applet.ts`, which takes a plain
 * callback and never imports `AgentContext`, and the split is the recursion
 * guard for free.
 */

const BUILDER_SPECIALIST_ID = 'applet-builder';

/** Returns the driver's answer — the spec, the problems and the planId. */
export type AppletDesigner = (
  target: PlanTarget,
  opts?: { stages?: readonly PlanStage[]; nudge?: string; planId?: string; signal?: AbortSignal },
) => Promise<{ designed: true; text: string } | { designed: false; reason: string }>;

/**
 * What the driver is asked.
 *
 * Deliberately short, and it hands over the applet's own facts rather than
 * instructions: the method is its system prompt, and restating it here would
 * be a second copy that drifts. A re-plan request is passed through as a
 * sentence rather than as parameters, because the driver decides which stage
 * that actually means — which is the whole reason it exists.
 */
function buildDesignerBrief(
  target: PlanTarget,
  opts: { stages?: readonly PlanStage[]; nudge?: string; planId?: string } = {},
): string {
  const intent = renderIntentLines(target.intent);
  return [
    `Plan an applet called "${target.name}".`,
    '',
    `What it is for: ${target.description || '(not stated)'}`,
    '',
    'What the person said:',
    intent.length > 0 ? intent.join('\n') : '(nothing recorded — say so rather than inventing one)',
    ...(opts.planId
      ? ['', `Build on the existing plan \`${opts.planId}\` rather than starting again.`]
      : []),
    ...(opts.stages?.length ? ['', `They asked to redo: ${opts.stages.join(', ')}.`] : []),
    ...(opts.nudge ? ['', 'What they want different:', opts.nudge] : []),
  ].join('\n');
}

export function makeAppletDesigner(ctx: AgentContext): AppletDesigner {
  return async (target, opts = {}) => {
    try {
      const pass = await runAppletPass(ctx, {
        specialistId: BUILDER_SPECIALIST_ID,
        input: buildDesignerBrief(target, opts),
        runLabel: `[design] ${target.name}`,
        signal: opts.signal,
      });
      if (!pass.ok) return { designed: false, reason: pass.reason };
      const text = typeof pass.result === 'string' ? pass.result.trim() : '';
      return text
        ? { designed: true, text }
        : { designed: false, reason: 'the designer returned nothing' };
    } catch (err) {
      // The caller decides what an abort means; here it is only named.
      const reason = passFailureReason(err);
      debugLog('applet:design:error', { name: target.name, reason });
      return { designed: false, reason };
    }
  };
}
