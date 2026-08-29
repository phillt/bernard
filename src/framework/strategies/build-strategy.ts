import type { BernardConfig } from '../../config.js';
import { isReactEffective } from '../../policy/effective.js';
import type { PolicyDecision } from '../../policy/types.js';
import { NormalStrategy } from './normal.js';
import { PlanReconcileStrategy } from './plan-reconcile.js';
import { ReActStrategy } from './react.js';
import type { ExecutionStrategy } from './types.js';

export interface BuildStrategyOpts {
  /**
   * Forwarded to {@link ReActStrategy}. Specialist sites pass 0.25 to preserve
   * the historical reduced enforcement budget; main agent leaves it undefined.
   */
  enforcementStepRatio?: number;
  /**
   * Per-turn strategy override from the Policy Engine. When undefined,
   * wrappers fall back to `config.coordinatorMode === 'on'`. When defined,
   * wrappers prefer this value — that's the seam #167 uses so the Qualifier
   * can vary strategy per turn without flipping the global config flag.
   */
  strategyId?: PolicyDecision['strategyId'];
  /**
   * Opt in to plan reconciliation on non-ReAct turns (#303). Main agent only:
   * it is the site whose abandoned plans the user actually sees. Specialist
   * sites leave it unset and keep exactly today's behavior, and the definitions
   * that instantiate {@link NormalStrategy} directly never reach this builder.
   */
  enforcePlanReconcile?: boolean;
}

/**
 * Wraps an inner strategy with a configuration-dependent decorator and either
 * returns the wrapped strategy or `null` to skip. Registered factories run in
 * registration order — `buildStrategy` iterates them and applies any non-null
 * return.
 *
 * Adding a new strategy is one new file (the strategy + a `registerStrategy`
 * call) plus one import line in this file's bootstrap section below.
 */
export type StrategyWrapper = (
  inner: ExecutionStrategy,
  config: BernardConfig,
  opts: BuildStrategyOpts,
) => ExecutionStrategy | null;

const wrappers: StrategyWrapper[] = [];

/** Register a {@link StrategyWrapper}. Called at module load time. */
export function registerStrategy(wrapper: StrategyWrapper): void {
  wrappers.push(wrapper);
}

/** For tests: drop all registered wrappers. */
export function _resetStrategiesForTests(): void {
  wrappers.length = 0;
}

/**
 * Composes the active strategies for a site. Starts from {@link NormalStrategy}
 * and applies each registered wrapper. The wrapper order is the registration
 * order — bootstrap registrations below define the canonical chain.
 */
export function buildStrategy(
  config: BernardConfig,
  opts: BuildStrategyOpts = {},
): ExecutionStrategy {
  let strategy: ExecutionStrategy = new NormalStrategy();
  for (const wrap of wrappers) {
    const next = wrap(strategy, config, opts);
    if (next) strategy = next;
  }
  return strategy;
}

// ---- Bootstrap registrations -------------------------------------------------
// Each new strategy adds one import + one registerStrategy call here.

// Reconciliation for turns ReAct did NOT claim. Gated on the opposite polarity
// of the same predicate as the wrapper above, so the two can never both wrap a
// single turn — exactly-once enforcement holds by construction, independent of
// registration order (#303).
registerStrategy((inner, config, opts) =>
  opts.enforcePlanReconcile && !isReactEffective(config, { strategyId: opts.strategyId })
    ? new PlanReconcileStrategy(inner)
    : null,
);

registerStrategy((inner, config, opts) => {
  // Prefer the Policy Engine's per-turn decision; fall back to
  // `config.coordinatorMode === 'on'` when the engine hasn't supplied one
  // (e.g. specialist sub-agents, which don't run through the engine).
  const reactWanted = isReactEffective(config, { strategyId: opts.strategyId });
  // Forward `effectiveReactMode: true` so the constructed strategy's runtime
  // guard (and its `shouldEnforcePlan` call) doesn't re-consult the global
  // flag and silently no-op when the policy override wanted ReAct.
  return reactWanted
    ? new ReActStrategy(inner, {
        enforcementStepRatio: opts.enforcementStepRatio,
        effectiveReactMode: true,
      })
    : null;
});
