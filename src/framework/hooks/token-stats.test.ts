import { describe, it, expect } from 'vitest';
import { tokenStatsHook, tokenTotalsHook, type TokenStatsTarget } from './token-stats.js';
import type { SpinnerStats } from '../../output.js';
import type { StepFinishPayload } from './types.js';

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
    },
  };
}

function step(over: Partial<StepFinishPayload>): StepFinishPayload {
  return { text: '', toolCalls: [], toolResults: [], ...over };
}

describe('token-stats cache accumulation (#269)', () => {
  it('accumulates Anthropic cache read/write tokens (main hook)', async () => {
    const target = makeTarget();
    const hook = tokenStatsHook(target);
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
    const hook = tokenStatsHook(target);
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
    const hook = tokenTotalsHook(target);
    await hook.onStepFinish!(step({ usage: { promptTokens: 300, completionTokens: 5 } }));
    expect(target.spinnerStats.turnCacheReadTokens).toBe(0);
    expect(target.spinnerStats.turnCompletionTokens).toBe(5);
  });
});
