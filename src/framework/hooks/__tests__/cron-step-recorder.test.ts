import { describe, it, expect } from 'vitest';
import { cronStepRecorderHook } from '../cron-step-recorder.js';
import type { CronLogStep } from '../../../cron/log-store.js';

describe('cronStepRecorderHook', () => {
  it('accumulates steps with monotonically increasing stepIndex', async () => {
    const steps: CronLogStep[] = [];
    const hook = cronStepRecorderHook(steps);
    await hook.onStepFinish!({
      text: 'a',
      toolCalls: [],
      toolResults: [],
      usage: { promptTokens: 1, completionTokens: 2 },
      finishReason: 'stop',
    });
    await hook.onStepFinish!({
      text: 'b',
      toolCalls: [],
      toolResults: [],
      usage: { promptTokens: 3, completionTokens: 4 },
      finishReason: 'stop',
    });
    expect(steps.length).toBe(2);
    expect(steps[0].stepIndex).toBe(0);
    expect(steps[1].stepIndex).toBe(1);
  });

  it('maps tool calls and results into the step record', async () => {
    const steps: CronLogStep[] = [];
    const hook = cronStepRecorderHook(steps);
    await hook.onStepFinish!({
      text: '',
      toolCalls: [{ toolName: 'shell', toolCallId: 't1', args: { command: 'ls' } }],
      toolResults: [{ toolName: 'shell', toolCallId: 't1', result: 'ok' }],
      usage: { promptTokens: 5, completionTokens: 6 },
      finishReason: 'tool-calls',
    });
    expect(steps[0].toolCalls).toEqual([
      { toolName: 'shell', toolCallId: 't1', args: { command: 'ls' } },
    ]);
    expect(steps[0].toolResults).toEqual([{ toolName: 'shell', toolCallId: 't1', result: 'ok' }]);
    expect(steps[0].usage).toEqual({ promptTokens: 5, completionTokens: 6, totalTokens: 11 });
    expect(steps[0].finishReason).toBe('tool-calls');
  });

  it('truncates oversized string results in place', async () => {
    const steps: CronLogStep[] = [];
    const hook = cronStepRecorderHook(steps);
    const big = 'x'.repeat(20000);
    await hook.onStepFinish!({
      text: '',
      toolCalls: [{ toolName: 'shell', toolCallId: 't1', args: {} }],
      toolResults: [{ toolName: 'shell', toolCallId: 't1', result: big }],
    });
    const stored = steps[0].toolResults[0].result as string;
    expect(stored.length).toBeLessThan(big.length);
    expect(stored).toContain('truncated');
  });

  it('defaults missing usage / finishReason to zeros / "unknown"', async () => {
    const steps: CronLogStep[] = [];
    const hook = cronStepRecorderHook(steps);
    await hook.onStepFinish!({ text: '', toolCalls: [], toolResults: [] });
    expect(steps[0].usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    expect(steps[0].finishReason).toBe('unknown');
  });
});
