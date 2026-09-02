import { describe, it, expect, beforeEach } from 'vitest';

import {
  tokenStatsHook,
  tokenTotalsHook,
  makeOutOfTurnUsageRecorder,
  type TokenStatsTarget,
  type UsageRecord,
} from '../token-stats.js';
import type { SpinnerStats } from '../../../output.js';

beforeEach(() => {});

function makeStats(over: Partial<SpinnerStats> = {}): SpinnerStats {
  return {
    startTime: 0,
    turnPromptTokens: 0,
    turnCompletionTokens: 0,
    latestPromptTokens: 0,
    model: 'claude-x',
    ...over,
  };
}

describe('tokenStatsHook', () => {
  it('writes lastStepPromptTokens from usage', async () => {
    const target: TokenStatsTarget = { lastStepPromptTokens: 0, spinnerStats: null };
    const hook = tokenStatsHook(target);
    await hook.onStepFinish!({
      text: '',
      toolCalls: [],
      toolResults: [],
      usage: { promptTokens: 1234, completionTokens: 56 },
    });
    expect(target.lastStepPromptTokens).toBe(1234);
  });

  it('accumulates spinner stats when present', async () => {
    const target: TokenStatsTarget = {
      lastStepPromptTokens: 0,
      spinnerStats: makeStats({ turnPromptTokens: 100, turnCompletionTokens: 50 }),
    };
    const hook = tokenStatsHook(target);
    await hook.onStepFinish!({
      text: '',
      toolCalls: [],
      toolResults: [],
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    expect(target.spinnerStats!.turnPromptTokens).toBe(110);
    expect(target.spinnerStats!.turnCompletionTokens).toBe(55);
    expect(target.spinnerStats!.latestPromptTokens).toBe(10);
  });

  it('skips spinner stats mutation when spinnerStats is null', async () => {
    const target: TokenStatsTarget = { lastStepPromptTokens: 0, spinnerStats: null };
    const hook = tokenStatsHook(target);
    await hook.onStepFinish!({
      text: '',
      toolCalls: [],
      toolResults: [],
      usage: { promptTokens: 9, completionTokens: 1 },
    });
    expect(target.lastStepPromptTokens).toBe(9);
  });

  it('handles missing usage gracefully', async () => {
    const target: TokenStatsTarget = { lastStepPromptTokens: 42, spinnerStats: makeStats() };
    const hook = tokenStatsHook(target);
    await hook.onStepFinish!({ text: '', toolCalls: [], toolResults: [] });
    expect(target.lastStepPromptTokens).toBe(42);
  });
});

describe('tokenTotalsHook', () => {
  it('bumps only the per-turn odometer, never the gauge or compression headroom', async () => {
    const target: TokenStatsTarget = {
      lastStepPromptTokens: 0,
      spinnerStats: makeStats({ turnPromptTokens: 100, turnCompletionTokens: 50 }),
    };
    const hook = tokenTotalsHook(target);
    await hook.onStepFinish!({
      text: '',
      toolCalls: [],
      toolResults: [],
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    expect(target.spinnerStats!.turnPromptTokens).toBe(110);
    expect(target.spinnerStats!.turnCompletionTokens).toBe(55);
    // Sub-agent steps must NOT disturb the main-only context gauge...
    expect(target.spinnerStats!.latestPromptTokens).toBe(0);
    // ...nor the main agent's compression-headroom field.
    expect(target.lastStepPromptTokens).toBe(0);
  });

  it('no-ops when spinnerStats is null (cron / headless)', async () => {
    const target: TokenStatsTarget = { lastStepPromptTokens: 0, spinnerStats: null };
    const hook = tokenTotalsHook(target);
    await hook.onStepFinish!({
      text: '',
      toolCalls: [],
      toolResults: [],
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    expect(target.lastStepPromptTokens).toBe(0);
  });

  it('no-ops when usage is missing', async () => {
    const target: TokenStatsTarget = {
      lastStepPromptTokens: 0,
      spinnerStats: makeStats({ turnPromptTokens: 7, turnCompletionTokens: 3 }),
    };
    const hook = tokenTotalsHook(target);
    await hook.onStepFinish!({ text: '', toolCalls: [], toolResults: [] });
    expect(target.spinnerStats!.turnPromptTokens).toBe(7);
    expect(target.spinnerStats!.turnCompletionTokens).toBe(3);
  });
});

describe('makeOutOfTurnUsageRecorder (#432)', () => {
  // Spend that lands after `finalizeTurnStats()` has closed the ledger — a
  // between-turn `/compact`, or the post-turn speech normalizer. Writing it to
  // the per-turn ledger would not merely mis-attribute it: the next
  // `beginTurnStats()` clears that ledger, so the cost would vanish from the
  // session total entirely.
  const priced: UsageRecord = {
    bucket: 'cheap',
    site: 'speech-normalizer',
    provider: 'anthropic',
    modelName: 'claude-haiku-4-5-20251001',
    promptTokens: 100,
    completionTokens: 50,
  };

  function makeSink() {
    const records: unknown[] = [];
    return {
      sessionId: 's1',
      turn: 3,
      records,
      record: (t: unknown) => void records.push(t),
    };
  }

  it('is a no-op when no stats are mounted', () => {
    const target = { spinnerStats: null };
    expect(() => makeOutOfTurnUsageRecorder(target)(priced)).not.toThrow();
  });

  it('never touches the per-turn ledger', () => {
    const stats = makeStats({ sessionCostUsd: 0, turnLedger: new Map() });
    makeOutOfTurnUsageRecorder({ spinnerStats: stats })(priced);
    expect(stats.turnLedger!.size).toBe(0);
    expect(stats.turnPromptTokens).toBe(0);
  });

  it('records into the durable sink so the per-layer breakdown sees it', () => {
    const sink = makeSink();
    const stats = makeStats({
      sessionCostUsd: 0,
      sessionTelemetry: sink as unknown as SpinnerStats['sessionTelemetry'],
    });
    makeOutOfTurnUsageRecorder({ spinnerStats: stats })(priced);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ site: 'speech-normalizer', sessionId: 's1', turn: 3 });
  });

  it('marks the session total as partial when a row could not be priced', () => {
    // An unpriced row must make the session figure read as a floor rather than
    // vanish into a clean $0.00.
    const stats = makeStats({ sessionCostUsd: 0, sessionCostPartial: false });
    makeOutOfTurnUsageRecorder({ spinnerStats: stats })({
      ...priced,
      modelName: 'not-in-any-catalog',
      provider: 'nowhere',
    });
    expect(stats.sessionCostPartial).toBe(true);
    expect(stats.sessionCostUsd).toBe(0);
  });
});
