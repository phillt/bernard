import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../output.js', () => ({
  startSpinner: vi.fn(),
  buildSpinnerMessage: vi.fn(() => 'msg'),
}));

import { tokenStatsHook, type TokenStatsTarget } from '../token-stats.js';
import { startSpinner } from '../../../output.js';
import type { SpinnerStats } from '../../../output.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeStats(over: Partial<SpinnerStats> = {}): SpinnerStats {
  return {
    startTime: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
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
      spinnerStats: makeStats({ totalPromptTokens: 100, totalCompletionTokens: 50 }),
    };
    const hook = tokenStatsHook(target);
    await hook.onStepFinish!({
      text: '',
      toolCalls: [],
      toolResults: [],
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    expect(target.spinnerStats!.totalPromptTokens).toBe(110);
    expect(target.spinnerStats!.totalCompletionTokens).toBe(55);
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
    // No spinner restart either
    expect(startSpinner).not.toHaveBeenCalled();
  });

  it('restarts spinner when step had tool calls AND spinnerStats present', async () => {
    const target: TokenStatsTarget = { lastStepPromptTokens: 0, spinnerStats: makeStats() };
    const hook = tokenStatsHook(target);
    await hook.onStepFinish!({
      text: '',
      toolCalls: [{ toolName: 'shell', toolCallId: 't', args: {} }],
      toolResults: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    expect(startSpinner).toHaveBeenCalledTimes(1);
  });

  it('does not restart spinner when no tool calls', async () => {
    const target: TokenStatsTarget = { lastStepPromptTokens: 0, spinnerStats: makeStats() };
    const hook = tokenStatsHook(target);
    await hook.onStepFinish!({
      text: 'final',
      toolCalls: [],
      toolResults: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    expect(startSpinner).not.toHaveBeenCalled();
  });

  it('handles missing usage gracefully', async () => {
    const target: TokenStatsTarget = { lastStepPromptTokens: 42, spinnerStats: makeStats() };
    const hook = tokenStatsHook(target);
    await hook.onStepFinish!({ text: '', toolCalls: [], toolResults: [] });
    expect(target.lastStepPromptTokens).toBe(42); // unchanged
  });
});
