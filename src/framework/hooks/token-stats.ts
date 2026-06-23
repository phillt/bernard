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
 * Adds one step's usage to the per-turn ↑/↓ odometer. The single mutation point
 * shared by both hooks so the field names never drift between them.
 */
function accumulateTurnOdometer(
  stats: SpinnerStats,
  usage: { promptTokens: number; completionTokens: number },
): void {
  stats.turnPromptTokens += usage.promptTokens;
  stats.turnCompletionTokens += usage.completionTokens;
}

/**
 * Add a step's Anthropic prompt-cache token counts to the per-turn counters
 * (#269). `cache_read_input_tokens` / `cache_creation_input_tokens` arrive as
 * `number | null` (null on a cache miss), so coerce to 0.
 */
function accumulateCacheTokens(
  stats: SpinnerStats,
  providerMetadata: { anthropic?: { cacheCreationInputTokens?: number | null; cacheReadInputTokens?: number | null } } | undefined,
): void {
  const a = providerMetadata?.anthropic;
  if (!a) return;
  stats.turnCacheReadTokens += a.cacheReadInputTokens ?? 0;
  stats.turnCacheWriteTokens += a.cacheCreationInputTokens ?? 0;
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
    onStepFinish: ({ usage, providerMetadata }) => {
      if (usage) {
        target.lastStepPromptTokens = usage.promptTokens;
        if (target.spinnerStats) {
          accumulateTurnOdometer(target.spinnerStats, usage);
          target.spinnerStats.latestPromptTokens = usage.promptTokens;
        }
      }
      if (target.spinnerStats) accumulateCacheTokens(target.spinnerStats, providerMetadata);
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
    onStepFinish: ({ usage, providerMetadata }) => {
      if (target.spinnerStats) {
        if (usage) accumulateTurnOdometer(target.spinnerStats, usage);
        accumulateCacheTokens(target.spinnerStats, providerMetadata);
      }
    },
  };
}
