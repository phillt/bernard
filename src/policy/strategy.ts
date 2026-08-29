import { DefaultQualifier, type Qualifier } from '../qualifier/index.js';
import type { PolicyDecision, SubPolicy } from './types.js';

type StrategyId = NonNullable<PolicyDecision['strategyId']>;

/**
 * Singleton qualifier instance — stateless, safe to share. Tests can build
 * a fresh `DefaultQualifier` if they need to swap behavior.
 */
const defaultQualifier: Qualifier = new DefaultQualifier();

/**
 * Selects the execution strategy for the main agent (#167).
 *
 * Reads `config.coordinatorMode`:
 *  - `'on'`   → always ReAct, reason `coordinator-mode-on`
 *  - `'off'`  → always Normal, reason `coordinator-mode-off`
 *  - `'auto'` → delegates to the Qualifier (`src/qualifier/`), which
 *               classifies the user message using rule-based features
 *               grounded in LLM-routing research (RouteLLM, FrugalGPT,
 *               Topaz, MoMA, RouterArena). The qualifier's reason code
 *               propagates up unchanged so downstream telemetry can name
 *               the signal that fired.
 */
export const strategyPolicy: SubPolicy<{
  id: StrategyId;
  /**
   * Raw qualifier feature map, forwarded so `policy:decide` can log it (#385).
   * `reason` names the branch that won; this names what was live when it did —
   * without it a misclassification can only be diagnosed by reading the source
   * and reconstructing the inputs by hand. Absent for the `on`/`off`
   * short-circuits, which consult no signals.
   */
  signals?: Record<string, boolean | number | string>;
}> = (input) => {
  switch (input.config.coordinatorMode) {
    case 'on':
      return { id: 'react', reason: 'coordinator-mode-on' };
    case 'off':
      return { id: 'normal', reason: 'coordinator-mode-off' };
    case 'auto':
    default: {
      const result = defaultQualifier.qualify({
        userText: input.userInput,
        config: input.config,
        context: { turnIndex: input.turnIndex },
      });
      return { id: result.strategyId, reason: result.reason, signals: result.signals };
    }
  }
};
