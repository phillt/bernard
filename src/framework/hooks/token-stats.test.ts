import { describe, it, expect } from 'vitest';
import {
  tokenStatsHook,
  tokenTotalsHook,
  recordTurnUsage,
  type TokenStatsTarget,
  type HookModelInfo,
} from './token-stats.js';
import type { SpinnerStats, TurnUsageEntry } from '../../output.js';
import type { StepFinishPayload } from './types.js';

const MAIN_INFO: HookModelInfo = {
  bucket: 'premium',
  site: 'main',
  provider: 'anthropic',
  modelName: 'claude-opus-4-8',
};

function makeTarget(): TokenStatsTarget & { spinnerStats: SpinnerStats } {
  return {
    lastStepPromptTokens: 0,
    spinnerStats: {
      startTime: 0,
      turnPromptTokens: 0,
      turnCompletionTokens: 0,
      latestPromptTokens: 0,
      turnCacheReadTokens: 0,
      turnCacheWriteTokens: 0,
      model: 'claude-opus-4-8',
      turnLedger: new Map<string, TurnUsageEntry>(),
    },
  };
}

function step(over: Partial<StepFinishPayload>): StepFinishPayload {
  return { text: '', toolCalls: [], toolResults: [], ...over };
}

describe('token-stats cache accumulation (#269)', () => {
  it('accumulates Anthropic cache read/write tokens (main hook)', async () => {
    const target = makeTarget();
    const hook = tokenStatsHook(target, MAIN_INFO);
    await hook.onStepFinish!(
      step({
        usage: { promptTokens: 2000, completionTokens: 50 },
        providerMetadata: {
          anthropic: { cacheReadInputTokens: 1800, cacheCreationInputTokens: 200 },
        },
      }),
    );
    expect(target.spinnerStats.turnCacheReadTokens).toBe(1800);
    expect(target.spinnerStats.turnCacheWriteTokens).toBe(200);
    expect(target.spinnerStats.turnPromptTokens).toBe(2000);
  });

  it('treats null cache counts (cache miss) as 0', async () => {
    const target = makeTarget();
    const hook = tokenStatsHook(target, MAIN_INFO);
    await hook.onStepFinish!(
      step({
        usage: { promptTokens: 500, completionTokens: 10 },
        providerMetadata: { anthropic: { cacheReadInputTokens: null, cacheCreationInputTokens: null } },
      }),
    );
    expect(target.spinnerStats.turnCacheReadTokens).toBe(0);
    expect(target.spinnerStats.turnCacheWriteTokens).toBe(0);
  });

  it('is a no-op for non-Anthropic steps (no providerMetadata)', async () => {
    const target = makeTarget();
    const hook = tokenTotalsHook(target, { ...MAIN_INFO, bucket: 'cheap', site: 'sub' });
    await hook.onStepFinish!(step({ usage: { promptTokens: 300, completionTokens: 5 } }));
    expect(target.spinnerStats.turnCacheReadTokens).toBe(0);
    expect(target.spinnerStats.turnCompletionTokens).toBe(5);
  });
});

describe('recordTurnUsage ledger (#258)', () => {
  it('aggregates the odometer as the sum of ledger rows and counts calls', () => {
    const { spinnerStats: stats } = makeTarget();
    recordTurnUsage(stats, { ...MAIN_INFO, promptTokens: 1000, completionTokens: 100 });
    recordTurnUsage(stats, { ...MAIN_INFO, promptTokens: 500, completionTokens: 40 });
    recordTurnUsage(stats, {
      bucket: 'cheap',
      site: 'rewriter',
      provider: 'anthropic',
      modelName: 'claude-haiku-4-5-20251001',
      promptTokens: 200,
      completionTokens: 20,
    });

    // Aggregate = sum of every row.
    expect(stats.turnPromptTokens).toBe(1700);
    expect(stats.turnCompletionTokens).toBe(160);

    // Same (bucket, provider, model, site) folds into one row; calls counts steps.
    const mainRow = stats.turnLedger.get('premium|anthropic|claude-opus-4-8|main')!;
    expect(mainRow.promptTokens).toBe(1500);
    expect(mainRow.completionTokens).toBe(140);
    expect(mainRow.calls).toBe(2);

    // Distinct site → distinct row.
    expect(stats.turnLedger.size).toBe(2);
  });

  it('buckets tier-less pinned models under "pinned"', () => {
    const { spinnerStats: stats } = makeTarget();
    recordTurnUsage(stats, {
      bucket: 'pinned',
      site: 'specialist',
      provider: 'openai',
      modelName: 'gpt-5.2',
      promptTokens: 300,
      completionTokens: 10,
    });
    const row = stats.turnLedger.get('pinned|openai|gpt-5.2|specialist')!;
    expect(row.bucket).toBe('pinned');
    expect(row.calls).toBe(1);
  });
});
