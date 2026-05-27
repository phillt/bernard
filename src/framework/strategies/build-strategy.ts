import type { BernardConfig } from '../../config.js';
import { NormalStrategy } from './normal.js';
import { ReActStrategy } from './react.js';
import type { ExecutionStrategy } from './types.js';

export interface BuildStrategyOpts {
  /**
   * Forwarded to {@link ReActStrategy}. Specialist sites pass 0.25 to preserve
   * the historical reduced enforcement budget; main agent leaves it undefined.
   */
  enforcementStepRatio?: number;
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

registerStrategy((inner, config, opts) =>
  config.reactMode
    ? new ReActStrategy(inner, { enforcementStepRatio: opts.enforcementStepRatio })
    : null,
);
