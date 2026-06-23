import type { SpinnerStats, TurnUsageEntry, UsageBucket } from '../../output.js';
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
 * Identifies which model/tier a step's tokens should be attributed to (#258).
 * Supplied by `run.ts` (which has the resolved model in scope) when installing
 * the hooks, and by the pre-turn / compressor recorders.
 */
export interface HookModelInfo {
  bucket: UsageBucket;
  site: string;
  provider: string;
  modelName: string;
}

/** A single usage observation to fold into the per-turn aggregate + ledger. */
export interface UsageRecord extends HookModelInfo {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Callback that folds a usage observation into the per-turn ledger (#258).
 * Passed (type-only, so no runtime import cycle) into the pre-turn pipeline and
 * the compressor so their off-loop LLM calls count toward the turn total. The
 * REPL / Agent wires it to `(rec) => recordTurnUsage(spinnerStats, rec)`.
 */
export type UsageRecorder = (rec: UsageRecord) => void;

/**
 * The single per-turn accumulation point (#258). Bumps the aggregate ↑/↓ +
 * cache odometers **and** the per-tier/model `turnLedger` entry so the two can
 * never drift — the aggregate is, by construction, the sum of the ledger rows.
 * Every token-producing site (main step, sub step, pre-turn pipeline,
 * compressor) routes through here.
 */
export function recordTurnUsage(stats: SpinnerStats, rec: UsageRecord): void {
  // Defensive: stats constructed before #258 (or by a terse test stub) may lack
  // the ledger Map. Seed it rather than throw.
  if (!stats.turnLedger) stats.turnLedger = new Map<string, TurnUsageEntry>();
  const cacheRead = rec.cacheReadTokens ?? 0;
  const cacheWrite = rec.cacheWriteTokens ?? 0;

  stats.turnPromptTokens += rec.promptTokens;
  stats.turnCompletionTokens += rec.completionTokens;
  stats.turnCacheReadTokens += cacheRead;
  stats.turnCacheWriteTokens += cacheWrite;

  const key = `${rec.bucket}|${rec.provider}|${rec.modelName}|${rec.site}`;
  let entry = stats.turnLedger.get(key);
  if (!entry) {
    entry = {
      bucket: rec.bucket,
      site: rec.site,
      provider: rec.provider,
      modelName: rec.modelName,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      calls: 0,
    };
    stats.turnLedger.set(key, entry);
  }
  entry.promptTokens += rec.promptTokens;
  entry.completionTokens += rec.completionTokens;
  entry.cacheReadTokens += cacheRead;
  entry.cacheWriteTokens += cacheWrite;
  entry.calls += 1;
}

/**
 * Pull Anthropic prompt-cache counts off a step's provider metadata (#269).
 * They arrive as `number | null` (null on a cache miss) → coerce to 0.
 */
function cacheTokens(
  providerMetadata:
    | { anthropic?: { cacheCreationInputTokens?: number | null; cacheReadInputTokens?: number | null } }
    | undefined,
): { read: number; write: number } {
  const a = providerMetadata?.anthropic;
  return { read: a?.cacheReadInputTokens ?? 0, write: a?.cacheCreationInputTokens ?? 0 };
}

/**
 * Full per-step accounting for the **main agent**. After each step:
 *  - writes the latest prompt-token count onto `target.lastStepPromptTokens`
 *    (used downstream for compression-headroom calculations);
 *  - sets `latestPromptTokens` — the main agent's current context size, which
 *    the status-bar gauge measures;
 *  - records the step's usage into the per-turn aggregate + ledger, attributed
 *    to the supplied {@link HookModelInfo} (#258).
 *
 * Only the main agent installs this hook. Sub-agents / tool-wrappers / PAC
 * phases use {@link tokenTotalsHook} instead so their steps add to the per-turn
 * odometer/ledger without disturbing the gauge or the compression math (#234).
 */
export function tokenStatsHook(target: TokenStatsTarget, info: HookModelInfo): AgentHook {
  return {
    onStepFinish: ({ usage, providerMetadata }) => {
      if (usage) {
        target.lastStepPromptTokens = usage.promptTokens;
        if (target.spinnerStats) target.spinnerStats.latestPromptTokens = usage.promptTokens;
      }
      if (target.spinnerStats) {
        const c = cacheTokens(providerMetadata);
        recordTurnUsage(target.spinnerStats, {
          ...info,
          promptTokens: usage?.promptTokens ?? 0,
          completionTokens: usage?.completionTokens ?? 0,
          cacheReadTokens: c.read,
          cacheWriteTokens: c.write,
        });
      }
    },
  };
}

/**
 * Totals-only accounting for **non-main** dispatches (sub-agent, task,
 * specialist, tool-wrapper, PAC phases). Adds each step's usage to the per-turn
 * aggregate + ledger so the turn reflects its *full* cost — including work
 * offloaded to ephemeral sub-agents — but deliberately leaves `latestPromptTokens`
 * (the main-agent context gauge) and `lastStepPromptTokens` (main-agent
 * compression headroom) untouched. No-ops when `spinnerStats` is null, so cron /
 * headless dispatches (no stats target) cost nothing (#234).
 */
export function tokenTotalsHook(target: TokenStatsTarget, info: HookModelInfo): AgentHook {
  return {
    onStepFinish: ({ usage, providerMetadata }) => {
      if (!target.spinnerStats) return;
      const c = cacheTokens(providerMetadata);
      recordTurnUsage(target.spinnerStats, {
        ...info,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        cacheReadTokens: c.read,
        cacheWriteTokens: c.write,
      });
    },
  };
}
