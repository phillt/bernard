import type { BernardConfig } from '../config.js';
import type { PolicyDecision } from './types.js';

/**
 * Single source of truth for whether the active turn is running in ReAct
 * (coordinator) mode. The Policy Engine's per-turn `strategyId` wins when
 * present; otherwise the global `config.coordinatorMode` flag is consulted —
 * only `'on'` enables ReAct here. `'auto'` is treated as `'off'` for callers
 * that bypass the engine (e.g. specialist sub-agents), since qualification
 * is a main-agent-only concern.
 *
 * Every site that branches on ReAct vs. Normal must route through this
 * helper — otherwise the strategy registration, the strategy's runtime
 * guard, and the tool-set assembly drift apart and the agent ends up
 * running a coordinator loop without the tools the coordinator needs (or
 * vice versa).
 */
export function isReactEffective(
  config: Pick<BernardConfig, 'coordinatorMode'>,
  decision?: Pick<PolicyDecision, 'strategyId'>,
): boolean {
  const id = decision?.strategyId;
  if (id === 'react') return true;
  if (id === 'normal') return false;
  return config.coordinatorMode === 'on';
}

/**
 * Whether ReAct could run at ANY point this session — `'on'` always, `'auto'`
 * because the per-turn Qualifier may escalate. Session-stable (depends only on
 * the mode, not the per-turn decision), so it's the right predicate for
 * TOOL-SET membership: gating the `evaluate` tool on the per-turn
 * {@link isReactEffective} makes the tool block flip between Normal and ReAct
 * turns, which invalidates the Anthropic prompt cache (tools are the first,
 * largest cached block and can't carry a mid-array breakpoint). Keeping the
 * tool present for the whole session keeps the block byte-identical so the
 * cache holds. The ReAct *enforcement* loop still keys off the per-turn
 * {@link isReactEffective} in the strategy — same rationale as the always-on
 * `plan` tool: an exposed-but-unenforced tool on a Normal turn is harmless.
 */
export function isReactPossible(config: Pick<BernardConfig, 'coordinatorMode'>): boolean {
  return config.coordinatorMode !== 'off';
}
