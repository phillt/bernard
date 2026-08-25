import { describe, it, expect } from 'vitest';
import { cronStepRecorderHook } from '../cron-step-recorder.js';
import type { CronLogStep } from '../../../cron/log-store.js';
import { REDACTED } from '../../tools/redact.js';

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

/**
 * #347 — the cap used to test `typeof result === 'string'`, so the truncating
 * branch was effectively dead: every Bernard tool returns an object.
 */
describe('cronStepRecorderHook — object result cap', () => {
  function record(result: unknown, registry?: Record<string, unknown>) {
    const steps: CronLogStep[] = [];
    const hook = cronStepRecorderHook(steps, registry);
    void hook.onStepFinish!({
      text: '',
      toolCalls: [],
      toolResults: [{ toolName: 'shell', toolCallId: '1', result }],
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'stop',
    } as never);
    return steps[0].toolResults[0].result;
  }

  it('caps a multi-MB object result and marks it as truncated', () => {
    // The shape that made this matter: `shell` returns `{output, is_error}`
    // with a 10 MB maxBuffer and no cap on `output`.
    const out = record({ output: 'x'.repeat(2_000_000), is_error: false });
    expect(typeof out).toBe('string');
    expect(out as string).toContain('(truncated,');
    expect((out as string).length).toBeLessThan(11_000);
  });

  it('leaves a small object result structured', () => {
    // Readers that walk the shape keep working on everything that fits.
    const out = record({ output: 'ok', is_error: false });
    expect(out).toEqual({ output: 'ok', is_error: false });
  });

  it('still caps a long string result', () => {
    const out = record('y'.repeat(50_000));
    expect(out as string).toContain('(truncated, 50000 chars total)');
  });

  it('redacts a sensitive result without serializing it first', () => {
    const registry = {
      shell: {
        __bernardMeta: { name: 'shell', kind: 'dangerous', sensitiveResult: true },
      },
    };
    expect(record({ secret: 'hunter2' }, registry)).toBe(REDACTED);
  });

  it('survives a result with a cycle', () => {
    // `appendEntry` must never throw on a log write.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => record(cyclic)).not.toThrow();
  });
});
