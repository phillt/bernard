import { describe, it, expect, vi } from 'vitest';
import {
  tokenStatsHook,
  tokenTotalsHook,
  recordTurnUsage,
  type TokenStatsTarget,
  type HookModelInfo,
} from './token-stats.js';
import type { SpinnerStats, TurnUsageEntry } from '../../output.js';
import type { StepFinishPayload } from './types.js';
import { SessionTelemetry } from '../../session-telemetry.js';
import { runWithDispatchId } from '../dispatch-context.js';

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
      sessionCostUsd: 0,
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
        providerMetadata: {
          anthropic: { cacheReadInputTokens: null, cacheCreationInputTokens: null },
        },
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

  it('records nothing for a step with no usage payload (no phantom ledger row)', async () => {
    const target = makeTarget();
    const hook = tokenStatsHook(target, MAIN_INFO);
    await hook.onStepFinish!(step({ usage: undefined }));
    expect(target.spinnerStats.turnLedger.size).toBe(0);
    expect(target.spinnerStats.turnPromptTokens).toBe(0);
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

describe('recordTurnUsage → session telemetry sink', () => {
  it('feeds the durable sink once per call when present', () => {
    const { spinnerStats: stats } = makeTarget();
    stats.sessionTelemetry = new SessionTelemetry('sink1', { persist: false });
    recordTurnUsage(stats, { ...MAIN_INFO, promptTokens: 1000, completionTokens: 100 });
    recordTurnUsage(stats, {
      bucket: 'cheap',
      site: 'rewriter',
      provider: 'anthropic',
      modelName: 'claude-haiku-4-5-20251001',
      promptTokens: 200,
      completionTokens: 20,
    });
    const sum = stats.sessionTelemetry.summary();
    expect(sum.totals.calls).toBe(2);
    expect(sum.totals.promptTokens).toBe(1200);
    expect(sum.byLayer.get('main')!.calls).toBe(1);
    expect(sum.byLayer.get('rewriter')!.calls).toBe(1);
  });

  it('is a no-op (backward compatible) when no sink is attached', () => {
    const { spinnerStats: stats } = makeTarget();
    expect(stats.sessionTelemetry).toBeUndefined();
    expect(() =>
      recordTurnUsage(stats, { ...MAIN_INFO, promptTokens: 1, completionTokens: 1 }),
    ).not.toThrow();
  });
});

describe('per-step latency + dispatch-id stamping', () => {
  it('measures inter-step wall time and stamps callId/parentCallId from the ALS', async () => {
    vi.useFakeTimers();
    try {
      const target = makeTarget();
      target.spinnerStats.sessionTelemetry = new SessionTelemetry('lat1', { persist: false });

      await runWithDispatchId('parent', async () => {
        await runWithDispatchId('child', async () => {
          vi.setSystemTime(1_000);
          const hook = tokenTotalsHook(target, { ...MAIN_INFO, site: 'sub' }); // lastStepAt = 1000
          vi.setSystemTime(1_100);
          await hook.onStepFinish!(step({ usage: { promptTokens: 10, completionTokens: 2 } }));
          vi.setSystemTime(1_250);
          await hook.onStepFinish!(step({ usage: { promptTokens: 5, completionTokens: 1 } }));
        });
      });

      const sum = target.spinnerStats.sessionTelemetry.summary();
      expect(sum.totals.latencyMsTotal).toBe(250); // 100 + 150
      // Both steps ran in the 'child' dispatch nested under 'parent'.
      const node = sum.tree.find((n) => n.callId === 'child');
      expect(node).toBeDefined();
      expect(node!.parentCallId).toBe('parent');
      expect(node!.calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
