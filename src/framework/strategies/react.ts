import { REACT_COORDINATOR_PROMPT, computeEffectiveMaxSteps } from '../../react.js';
import { enforcePlan } from './plan-enforcement.js';
import type { AgentResult } from '../runner.js';
import type { ExecutionStrategy, IterateOpts, StrategyContext } from './types.js';

export interface ReActStrategyOpts {
  /**
   * Ratio (relative to `config.maxSteps`) used for the enforcement retry's
   * step budget. Defaults to 1.0 (i.e. the same effective budget as the
   * initial call). Specialist sites pass 0.25 to preserve the historical
   * `SPECIALIST_ENFORCEMENT_STEP_RATIO`.
   */
  enforcementStepRatio?: number;
  /**
   * Effective ReAct flag for this turn, resolved by the Policy Engine when
   * available (see `src/policy/effective.ts`). When set, `run()` uses this
   * instead of `ctx.config.coordinatorMode === 'on'`, which is required so a
   * per-turn `strategyId: 'react'` override actually engages coordinator
   * behavior even when the global toggle is `'off'` or `'auto'`. Defaults to
   * `ctx.config.coordinatorMode === 'on'` to preserve behavior for sub-agent
   * paths that don't go through the engine.
   */
  effectiveReactMode?: boolean;
}

/**
 * Wraps an inner strategy to add coordinator-mode behavior:
 * - Coordinator system-prompt suffix on every iterate call.
 * - Tripled `maxSteps` (clamped by {@link computeEffectiveMaxSteps}).
 * - Post-loop plan enforcement via the shared {@link enforcePlan} helper, with
 *   missing-plan enforcement ON (coordinator mode mandates a plan). Normal
 *   turns run the same helper with it off — see `plan-reconcile.ts` (#303).
 *
 * No-op when coordinator mode is not active — just delegates to inner.
 */
export class ReActStrategy implements ExecutionStrategy {
  constructor(
    private readonly inner: ExecutionStrategy,
    private readonly opts: ReActStrategyOpts = {},
  ) {}

  async run(ctx: StrategyContext): Promise<AgentResult> {
    const reactActive = this.opts.effectiveReactMode ?? ctx.config.coordinatorMode === 'on';
    if (!reactActive) return this.inner.run(ctx);

    const baseMaxSteps = ctx.baseMaxSteps ?? ctx.config.maxSteps;
    const initialMaxSteps = computeEffectiveMaxSteps(baseMaxSteps, true);
    const applyCoordinator = (opts: IterateOpts): IterateOpts => ({
      ...opts,
      systemSuffix: joinSystemSuffix(opts.systemSuffix, REACT_COORDINATOR_PROMPT),
      maxStepsOverride: opts.maxStepsOverride ?? initialMaxSteps,
    });

    const wrappedCtx: StrategyContext = {
      ...ctx,
      iterate: (opts) => ctx.iterate(applyCoordinator(opts)),
    };

    const result = await this.inner.run(wrappedCtx);

    // Enforcement budget is intentionally `config.maxSteps * enforcementRatio`
    // (not `baseMaxSteps * ratio`) to preserve historical behavior: callers
    // that reduce the initial budget (specialist halves it) still get the full
    // documented enforcement allowance, so `ratio = 0.25` means
    // `config.maxSteps * 0.25` regardless of the initial-call multiplier.
    const enforcementRatio = this.opts.enforcementStepRatio ?? 1;
    return enforcePlan({
      ctx,
      planStore: ctx.planStore,
      result,
      // Coordinator mode mandates planning, so a missing plan is enforceable
      // here — unlike on a Normal turn (#303).
      enforceMissingPlan: true,
      systemSuffix: REACT_COORDINATOR_PROMPT,
      enforcementMaxSteps: computeEffectiveMaxSteps(
        Math.ceil(ctx.config.maxSteps * enforcementRatio),
        true,
      ),
    });
  }
}

function joinSystemSuffix(existing: string | undefined, addition: string): string {
  if (!existing) return addition;
  if (existing.includes(addition)) return existing;
  return `${existing}\n\n${addition}`;
}
