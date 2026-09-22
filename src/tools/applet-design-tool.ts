import { z } from 'zod';
import { defineTool } from '../framework/tools/define-tool.js';
import { attachMeta } from '../framework/tools/adapter.js';
import { stashDesign, peekPlan } from '../apps/design-stash.js';
import { checkDesign } from '../apps/design-checks.js';
import { makeAppletPlanner, PLAN_STAGES } from './applet-planning.js';
import type { PlanTarget } from './applet-planning.js';
import type { AgentContext } from '../framework/context.js';

/**
 * The one tool the applet-design pipeline's driver holds.
 *
 * ## Why the driver does not dispatch the stages itself
 *
 * It was the obvious shape and it loses three things that cannot be recovered
 * in prose, each measured rather than supposed:
 *
 * 1. **The deterministic checks.** `parseStagePlan` and `checkDesign` are
 *    code. A model orchestrator cannot run them, so a control naming an
 *    action the scope never declared goes uncaught — which is the single
 *    failure this pipeline was rebuilt to catch.
 * 2. **The persisted design.** `stashDesign` is reachable only from here, so
 *    a driver running the stages by hand mints no `planId` and `create`'s
 *    `claimDesign` returns nothing. The applet ships with prose only.
 * 3. **Roughly five times its result budget.** `renderWrapperParentView` caps
 *    each nested result at ~3,920 characters AND caps the driver's own return
 *    at the same, where the pipeline caps per section and reaches ~20 KB.
 *
 * So the sequence, the briefs, the schemas, the checks and the caps all stay
 * in code, and this hands the driver the one verb it needs: plan, look, plan
 * part of it again. That is the judgement, and judgement is the half worth
 * giving to a focused prompt.
 *
 * ## It is reached by declaration, not by an overlay
 *
 * `buildDispatchOverlay` deliberately builds no applet tool — that is the
 * recursion guard, and it is a property of that function constructing nothing
 * rather than of two lists agreeing. Adding a key there and subtracting it in
 * `main.ts` would restore exactly the premise that comment records removing.
 *
 * Instead a record declares `drives: 'applet-design'` and `dispatchToolWrapper`
 * merges this in for that record alone. Unforgeable for the same reason
 * `pipeline` is: `create` copies an explicit field list, `update` has an
 * explicit allowlist, and neither names it.
 *
 * The guard is unchanged in substance. This tool cannot write, style, review
 * or open anything — it plans, and planning writes nothing to disk. A driver
 * cannot re-enter its own dispatch through it, because there is no dispatch
 * of itself to re-enter.
 */
export function createAppletDesignTool(ctx: AgentContext) {
  const plan = makeAppletPlanner(ctx);
  return attachMeta(
    defineTool({
      description:
        'Runs the applet design pipeline and returns the spec, the problems found in it, and ' +
        'a planId. Call it once with no arguments to plan everything. Read what comes back, ' +
        'and if one part is wrong call it again with `planId`, the `stages` to redo and a ' +
        '`nudge` saying what to change — the stages you do not name keep exactly what they ' +
        'decided the first time.',
      parameters: z.object({
        name: z.string().describe('What the applet is called.'),
        description: z.string().optional().describe('One line on what it is for.'),
        intent: z
          .record(z.string())
          .optional()
          .describe("The brief's intent model, as you were given it."),
        planId: z.string().optional().describe('A previous planId, to build on.'),
        stages: z
          .array(z.enum(PLAN_STAGES))
          .optional()
          .describe('Re-run only these stages; the rest are reused from `planId`.'),
        nudge: z
          .string()
          .max(600)
          .optional()
          .describe('What to do differently, applied to every stage being run.'),
      }),
      execute: async (args) => {
        const target: PlanTarget = {
          name: args.name,
          description: args.description ?? '',
          intent: (args.intent ?? {}) as PlanTarget['intent'],
        };
        const prior = peekPlan(args.planId);
        const outcome = await plan(target, {
          ...(args.stages?.length ? { only: args.stages } : {}),
          ...(args.nudge
            ? {
                nudges: Object.fromEntries(
                  (args.stages ?? PLAN_STAGES).map((s) => [s, args.nudge as string]),
                ),
              }
            : {}),
          ...(prior ? { prior } : {}),
        });
        if (!outcome.planned) return `Error: planning did not run (${outcome.reason}).`;

        // The same gate `applet plan` applies, and for the same reason: a plan
        // with refusals standing must not become buildable. Here it also tells
        // the driver exactly what its next re-run is for.
        const blocking = checkDesign(outcome.design).filter((i) => i.level === 'refuse');
        if (blocking.length > 0) {
          return (
            `${outcome.spec}\n\n**No planId issued** — ${blocking.length} ` +
            `${blocking.length === 1 ? 'problem' : 'problems'} above must be fixed first. ` +
            'Call this again naming the stage that got it wrong and what to change.'
          );
        }
        const planId = stashDesign(outcome.design, outcome.bodies);
        const reused = outcome.reused.length
          ? ` Reused unchanged: ${outcome.reused.join(', ')}.`
          : '';
        return `${outcome.spec}\n\nplanId: "${planId}"${reused}`;
      },
    }),
    {
      // A read: it dispatches planners and writes nothing anywhere. Classified
      // wrong it would be refused outright by the read-only block gate, with
      // nobody present to ask — the trap `interview` already hit.
      kind: 'read',
      sideEffect: 'none',
      name: 'applet_design',
    },
  );
}
