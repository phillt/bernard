import type { SpinnerStats } from '../../output.js';
import type { AgentHook } from './types.js';

/**
 * Target object whose fields the hook mutates in place. Implemented today
 * by the {@link Agent} instance (`this.lastStepPromptTokens`,
 * `this.spinnerStats`); tests can pass a plain object.
 */
export interface TokenStatsTarget {
  lastStepPromptTokens: number;
  spinnerStats: SpinnerStats | null;
}

/**
 * Full per-step accounting for the **main agent**. After each step:
 *  - writes the latest prompt-token count onto `target.lastStepPromptTokens`
 *    (used downstream for compression-headroom calculations);
 *  - accumulates the per-turn prompt + completion odometers on
 *    `target.spinnerStats` when set;
 *  - sets `latestPromptTokens` — the main agent's current context size, which
 *    the status-bar gauge measures.
 *
 * Only the main agent installs this hook. Sub-agents / tool-wrappers / PAC
 * phases use {@link tokenTotalsHook} instead so their steps add to the per-turn
 * odometer without disturbing the gauge or the compression math (#234).
 */
export function tokenStatsHook(target: TokenStatsTarget): AgentHook {
  return {
    onStepFinish: ({ usage }) => {
      if (usage) {
        target.lastStepPromptTokens = usage.promptTokens;
        if (target.spinnerStats) {
          target.spinnerStats.turnPromptTokens += usage.promptTokens;
          target.spinnerStats.turnCompletionTokens += usage.completionTokens;
          target.spinnerStats.latestPromptTokens = usage.promptTokens;
        }
      }
    },
  };
}

/**
 * Totals-only accounting for **non-main** dispatches (sub-agent, task,
 * specialist, tool-wrapper, PAC phases). Adds each step's usage to the per-turn
 * ↑/↓ odometer so it reflects the *full* turn cost — including work offloaded to
 * ephemeral sub-agents — but deliberately leaves `latestPromptTokens` (the
 * main-agent context gauge) and `lastStepPromptTokens` (main-agent compression
 * headroom) untouched. No-ops when `spinnerStats` is null, so cron / headless
 * dispatches (no stats target) cost nothing (#234).
 */
export function tokenTotalsHook(target: TokenStatsTarget): AgentHook {
  return {
    onStepFinish: ({ usage }) => {
      if (usage && target.spinnerStats) {
        target.spinnerStats.turnPromptTokens += usage.promptTokens;
        target.spinnerStats.turnCompletionTokens += usage.completionTokens;
      }
    },
  };
}
