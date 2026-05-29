import type { BernardConfig } from '../config.js';
import type { PolicyDecision } from './types.js';

/**
 * Single source of truth for whether the active turn is running in ReAct
 * (coordinator) mode. The Policy Engine's per-turn `strategyId` wins when
 * present; otherwise the global `config.reactMode` flag is consulted.
 *
 * Every site that branches on ReAct vs. Normal must route through this
 * helper — otherwise the strategy registration, the strategy's runtime
 * guard, and the tool-set assembly drift apart and the agent ends up
 * running a coordinator loop without the tools the coordinator needs (or
 * vice versa).
 */
export function isReactEffective(
  config: Pick<BernardConfig, 'reactMode'>,
  decision?: Pick<PolicyDecision, 'strategyId'>,
): boolean {
  const id = decision?.strategyId;
  if (id === 'react') return true;
  if (id === 'normal') return false;
  return config.reactMode;
}
