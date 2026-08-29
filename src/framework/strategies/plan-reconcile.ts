import { enforcePlan } from './plan-enforcement.js';
import type { AgentResult } from '../runner.js';
import type { ExecutionStrategy, StrategyContext } from './types.js';

/**
 * Holds a Normal turn to a plan it chose to make (#303) — see
 * `plan-enforcement.ts` for why the `plan` tool is mounted in every mode while
 * enforcement was not.
 *
 * Runs the shared loop with missing-plan enforcement **off**: reconcile what
 * exists, never nag a turn into planning. It deliberately passes no
 * `systemSuffix` and no step-budget override — injecting several KB of
 * coordinator instructions into a turn the qualifier routed to Normal is a real
 * per-call cost, and a Normal turn should stay one.
 *
 * Scope lives entirely in `build-strategy.ts`, which builds this only when the
 * caller opts in via `BuildStrategyOpts.enforcePlanReconcile` **and** ReAct is
 * not effective — so this and `ReActStrategy` are mutually exclusive by
 * construction and exactly one enforcement pass can run per turn.
 */
export class PlanReconcileStrategy implements ExecutionStrategy {
  constructor(private readonly inner: ExecutionStrategy) {}

  async run(ctx: StrategyContext): Promise<AgentResult> {
    const result = await this.inner.run(ctx);
    return enforcePlan({ ctx, planStore: ctx.planStore, result, enforceMissingPlan: false });
  }
}
