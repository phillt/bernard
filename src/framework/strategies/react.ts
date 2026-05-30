import type { CoreMessage } from 'ai';
import {
  REACT_AUTO_CANCEL_NOTE,
  REACT_COORDINATOR_PROMPT,
  REACT_ENFORCEMENT_MAX_RETRIES,
  buildEnforcementFeedback,
  computeEffectiveMaxSteps,
  shouldEnforcePlan,
} from '../../react.js';
import { truncateToolResults } from '../../context.js';
import { printInfo, printWarning } from '../../output.js';
import { debugLog } from '../../logger.js';
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
 * - Post-loop plan enforcement: re-prompt up to {@link REACT_ENFORCEMENT_MAX_RETRIES}
 *   times when the plan still has unresolved steps; auto-cancel the rest.
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

    let result = await this.inner.run(wrappedCtx);

    const planStore = ctx.planStore;
    if (
      !planStore ||
      !shouldEnforcePlan({
        reactMode: reactActive,
        aborted: ctx.abortSignal?.aborted === true,
        stepLimitHit: ctx.getStepLimitHit?.() === true,
        hasSteps: planStore.unresolvedCount() > 0,
      })
    ) {
      return result;
    }

    // Enforcement budget is intentionally `config.maxSteps * enforcementRatio`
    // (not `baseMaxSteps * ratio`) to preserve historical behavior: callers
    // that reduce the initial budget (specialist halves it) still get the full
    // documented enforcement allowance, so `ratio = 0.25` means
    // `config.maxSteps * 0.25` regardless of the initial-call multiplier.
    const enforcementRatio = this.opts.enforcementStepRatio ?? 1;
    const enforcementMaxSteps = computeEffectiveMaxSteps(
      Math.ceil(ctx.config.maxSteps * enforcementRatio),
      true,
    );
    const prefixTag = ctx.prefix ? `[${ctx.prefix}] ` : '';

    let attempts = 0;
    while (!planStore.isComplete() && attempts < REACT_ENFORCEMENT_MAX_RETRIES) {
      if (ctx.abortSignal?.aborted) break;
      attempts++;
      printWarning(
        `${prefixTag}Plan has ${planStore.unresolvedCount()} unresolved step(s). Prompting to resolve... (${attempts}/${REACT_ENFORCEMENT_MAX_RETRIES})`,
      );

      const enforcementExtra: CoreMessage[] = [
        ...truncateToolResults(result.response.messages as CoreMessage[]),
        { role: 'user', content: buildEnforcementFeedback(planStore.render()) },
      ];

      try {
        result = await ctx.iterate({
          extra: enforcementExtra,
          systemSuffix: REACT_COORDINATOR_PROMPT,
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
    }

    return result;
  }
}

function joinSystemSuffix(existing: string | undefined, addition: string): string {
  if (!existing) return addition;
  if (existing.includes(addition)) return existing;
  return `${existing}\n\n${addition}`;
}
