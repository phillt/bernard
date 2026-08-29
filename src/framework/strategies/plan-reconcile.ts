import { enforcePlan } from './plan-enforcement.js';
import type { AgentResult } from '../runner.js';
import type { ExecutionStrategy, StrategyContext } from './types.js';

/**
 * Holds a Normal turn to a plan it chose to make (#303).
 *
 * The `plan` tool is mounted in every mode, not just coordinator mode — the
 * main agent's tool block is the Anthropic prompt-cache prefix (#269) and has
 * to stay byte-stable, so tool membership cannot flip per turn. Enforcement,
 * however, was gated on `reactMode`, which left a gap: a Normal turn could
 * build a plan, show it to the user in the plan panel, and abandon it. Two
 * turns in one observed session did exactly that.
 *
 * This wrapper closes the gap by running the same {@link enforcePlan} loop with
 * missing-plan enforcement **off** — reconcile what exists, never nag a turn
 * into planning. It deliberately passes no `systemSuffix` and no step-budget
 * override: this is a Normal turn, and it should stay one.
 *
 * Scope is controlled entirely at construction. `build-strategy.ts` only builds
 * it when the caller opts in via `BuildStrategyOpts.enforcePlanReconcile` (main
 * agent only) **and** ReAct is not effective — so it and `ReActStrategy` are
 * mutually exclusive by construction rather than by a runtime check, and
 * exactly one enforcement pass can ever run for a turn.
 */
export class PlanReconcileStrategy implements ExecutionStrategy {
  constructor(private readonly inner: ExecutionStrategy) {}

  async run(ctx: StrategyContext): Promise<AgentResult> {
    const result = await this.inner.run(ctx);
    const planStore = ctx.planStore;
    // No plan store means no plan tool was mounted — nothing to reconcile.
    if (!planStore) return result;
    return enforcePlan({ ctx, planStore, result, enforceMissingPlan: false });
  }
}
