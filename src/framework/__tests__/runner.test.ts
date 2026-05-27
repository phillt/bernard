import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { runAgent, type AgentSpec } from '../runner.js';
import type { AgentHook } from '../hooks/types.js';
import { generateText } from 'ai';

beforeEach(() => {
  vi.clearAllMocks();
  (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    text: 'final',
    steps: [],
    response: { messages: [] },
    finishReason: 'stop',
  });
});

function makeSpec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    model: 'mock-model' as any,
    messages: [{ role: 'user', content: 'hi' }],
    ...over,
  };
}

describe('runAgent', () => {
  it('forwards all spec fields to generateText (param parity)', async () => {
    const prepareStep = vi.fn();
    const repair = vi.fn();
    const abortController = new AbortController();
    await runAgent(
      makeSpec({
        providerOptions: { anthropic: { thinking: { type: 'enabled' } } },
        tools: { shell: { description: 'sh' } as any },
        maxSteps: 7,
        maxTokens: 1024,
        system: 'sys',
        abortSignal: abortController.signal,
        prepareStep,
        repair,
      }),
    );
    const args = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.model).toBe('mock-model');
    expect(args.providerOptions).toEqual({ anthropic: { thinking: { type: 'enabled' } } });
    expect(args.tools).toEqual({ shell: { description: 'sh' } });
    expect(args.maxSteps).toBe(7);
    expect(args.maxTokens).toBe(1024);
    expect(args.system).toBe('sys');
    expect(args.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(args.abortSignal).toBe(abortController.signal);
    expect(args.experimental_prepareStep).toBe(prepareStep);
    expect(args.experimental_repairToolCall).toBe(repair);
  });

  it('omits onStepFinish entirely when no hooks are passed (critic shape)', async () => {
    await runAgent(makeSpec());
    const args = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.onStepFinish).toBeUndefined();
  });

  it('omits onStepFinish when all hooks lack the observer (e.g. repair-only)', async () => {
    await runAgent(makeSpec({ hooks: [{}, {}] }));
    const args = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.onStepFinish).toBeUndefined();
  });

  it('composes hook onStepFinish callbacks in declaration order', async () => {
    const order: string[] = [];
    const hookA: AgentHook = { onStepFinish: () => void order.push('a') };
    const hookB: AgentHook = { onStepFinish: () => void order.push('b') };
    const hookC: AgentHook = { onStepFinish: () => void order.push('c') };
    await runAgent(makeSpec({ hooks: [hookA, hookB, hookC] }));
    const args = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await args.onStepFinish({ text: '', toolCalls: [], toolResults: [] });
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('awaits async hooks before moving to the next', async () => {
    const order: string[] = [];
    const slow: AgentHook = {
      onStepFinish: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('slow');
      },
    };
    const fast: AgentHook = { onStepFinish: () => void order.push('fast') };
    await runAgent(makeSpec({ hooks: [slow, fast] }));
    const args = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await args.onStepFinish({ text: '', toolCalls: [], toolResults: [] });
    expect(order).toEqual(['slow', 'fast']);
  });

  it('returns the generateText result directly', async () => {
    const result = await runAgent(makeSpec());
    expect(result.text).toBe('final');
  });
});
