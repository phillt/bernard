import type { PolicyDecision, SubPolicy } from './types.js';

type StrategyId = NonNullable<PolicyDecision['strategyId']>;

/**
 * Selects the execution strategy for the main agent. Today: mirrors
 * `config.reactMode`. Future work (#167) introduces a Qualifier that
 * inspects `userInput` to choose `pac` / `single-shot` / etc.; this
 * sub-policy is the only place that needs to change.
 */
export const strategyPolicy: SubPolicy<{ id: StrategyId }> = (input) => {
  if (input.config.reactMode) {
    return { id: 'react', reason: 'react-mode-flag' };
  }
  return { id: 'normal', reason: 'react-mode-disabled' };
};
