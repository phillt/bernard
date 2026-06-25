import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

const logCalls: { label: string; data: any }[] = [];
vi.mock('../../logger.js', async () => {
  const actual = await vi.importActual<typeof import('../../logger.js')>('../../logger.js');
  return {
    ...actual,
    isDebugEnabled: () => !!(globalThis as { __debugForRunnerTest?: boolean }).__debugForRunnerTest,
    debugLog: (label: string, data: unknown) => {
      logCalls.push({ label, data });
    },
  };
});

import { runAgent, type AgentSpec } from '../runner.js';
import type { AgentHook } from '../hooks/types.js';
import { generateText } from 'ai';

beforeEach(() => {
  vi.clearAllMocks();
  logCalls.length = 0;
  (globalThis as { __debugForRunnerTest?: boolean }).__debugForRunnerTest = false;
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

  it('races the non-streaming await against the abort signal', async () => {
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}),
    );
    const ac = new AbortController();
    const p = runAgent(makeSpec({ abortSignal: ac.signal }));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects synchronously when the abort signal is already aborted', async () => {
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}),
    );
    const ac = new AbortController();
    ac.abort();
    await expect(runAgent(makeSpec({ abortSignal: ac.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('does not emit step:start / step:end / stuck when debug is off', async () => {
    await runAgent(makeSpec());
    const args = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await args.onStepFinish?.({ text: 'hi', toolCalls: [], toolResults: [] });
    const labels = logCalls.map((c) => c.label);
    expect(labels).not.toContain('step:start');
    expect(labels).not.toContain('step:end');
    expect(labels).not.toContain('agent:dispatch:stuck');
  });

  it('emits step:start (via prepareStep) and step:end with dispatchId when debug is on', async () => {
    (globalThis as { __debugForRunnerTest?: boolean }).__debugForRunnerTest = true;
    await runAgent(makeSpec());
    const args = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await args.experimental_prepareStep?.({ stepNumber: 0 });
    await args.onStepFinish?.({
      text: 'hi',
      toolCalls: [{ toolName: 'shell', toolCallId: 'c1', args: {} }],
      toolResults: [],
      usage: { promptTokens: 5, completionTokens: 3 },
      finishReason: 'tool-calls',
    });
    const start = logCalls.find((c) => c.label === 'step:start');
    const end = logCalls.find((c) => c.label === 'step:end');
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(start!.data.dispatchId).toMatch(/^[0-9a-f]{8}$/);
    expect(end!.data.dispatchId).toBe(start!.data.dispatchId);
    expect(end!.data.toolCalls).toEqual(['shell']);
    expect(end!.data.promptTokens).toBe(5);
  });

  it('tags agent:dispatch:start/end with dispatchId when debug is on', async () => {
    (globalThis as { __debugForRunnerTest?: boolean }).__debugForRunnerTest = true;
    await runAgent(makeSpec());
    const start = logCalls.find((c) => c.label === 'agent:dispatch:start');
    const end = logCalls.find((c) => c.label === 'agent:dispatch:end');
    expect(start?.data.dispatchId).toBeDefined();
    expect(end?.data.dispatchId).toBe(start?.data.dispatchId);
  });

  it('honors BERNARD_DISPATCH_TIMEOUT_MS by aborting with a self-describing error', async () => {
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { abortSignal?: AbortSignal }) =>
        new Promise((_, reject) => {
          opts.abortSignal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const prev = process.env.BERNARD_DISPATCH_TIMEOUT_MS;
    process.env.BERNARD_DISPATCH_TIMEOUT_MS = '20';
    try {
      // The bare AbortError is re-shaped so the agent's catch — which only
      // recognizes aborts on its own controller — renders the timeout
      // context instead of a generic "Agent error: Aborted".
      await expect(runAgent(makeSpec())).rejects.toThrow(
        /Dispatch timed out after 20 ms \(BERNARD_DISPATCH_TIMEOUT_MS\)/,
      );
    } finally {
      if (prev === undefined) delete process.env.BERNARD_DISPATCH_TIMEOUT_MS;
      else process.env.BERNARD_DISPATCH_TIMEOUT_MS = prev;
    }
  });

  it('does not re-shape a user abort as a dispatch timeout', async () => {
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { abortSignal?: AbortSignal }) =>
        new Promise((_, reject) => {
          opts.abortSignal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const prev = process.env.BERNARD_DISPATCH_TIMEOUT_MS;
    process.env.BERNARD_DISPATCH_TIMEOUT_MS = '5000';
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    try {
      await expect(runAgent({ ...makeSpec(), abortSignal: ac.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
    } finally {
      if (prev === undefined) delete process.env.BERNARD_DISPATCH_TIMEOUT_MS;
      else process.env.BERNARD_DISPATCH_TIMEOUT_MS = prev;
    }
  });
});
