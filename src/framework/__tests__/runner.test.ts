import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
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
import { providerStallInfo, DISPATCH_ABORT_NAME } from '../../error-taxonomy.js';
import { beginToolCall, __resetInFlightCalls } from '../../tools/in-flight.js';
import type { AgentHook } from '../hooks/types.js';
import { generateText, streamText } from 'ai';

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
    // NOT identity: since #607 every dispatch has a liveness budget, so every
    // dispatch chains a fresh controller off the caller's signal and forwards
    // that. The property that replaces identity — the caller's Esc still
    // reaching the SDK — is asserted in its own case below, where the dispatch
    // is still running and the chain has not yet been torn down.
    expect(args.abortSignal).not.toBe(abortController.signal);
    expect(args.abortSignal).toBeInstanceOf(AbortSignal);
    expect(args.experimental_prepareStep).toBe(prepareStep);
    expect(args.experimental_repairToolCall).toBe(repair);
  });

  /**
   * These two used to assert `onStepFinish` was UNDEFINED for a hook-less
   * dispatch. That contract was given up deliberately: the runner now always
   * composes a step COUNTER, because `stepsCompleted` is read by stall recovery
   * to decide whether re-running a dispatch would re-execute tool calls that
   * already ran — and a retry that re-sends six completed steps' worth of writes
   * must not depend on whether someone set BERNARD_DEBUG.
   *
   * What the tests are really protecting is that the runner does not disturb a
   * caller's hooks, which is asserted directly below and is unchanged.
   */
  it('always attaches a step counter, even with no caller hooks (critic shape)', async () => {
    await runAgent(makeSpec());
    const args = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof args.onStepFinish).toBe('function');
  });

  it('attaches the counter alongside hooks that lack an observer (repair-only)', async () => {
    await runAgent(makeSpec({ hooks: [{}, {}] }));
    const args = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof args.onStepFinish).toBe('function');
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

/**
 * Mid-stream stall guard (#325). The first-byte guard (#302) bounds the wait
 * for headers; these cover what happens after they arrive.
 */
describe('runAgent — mid-stream stall guard', () => {
  /**
   * Builds a `streamText` double whose `fullStream` yields `parts`, then stops
   * producing without ending — the shape of a provider that accepted the POST,
   * sent some tokens, and went silent. Every result promise stays pending too,
   * so nothing but the guard can unwind the run.
   */
  function makeStalledStream(parts: unknown[]) {
    const pending = new Promise<never>(() => {});
    return {
      fullStream: {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next: async () =>
              i < parts.length ? { value: parts[i++], done: false } : await pending,
          };
        },
      },
      text: pending,
      steps: pending,
      finishReason: pending,
      usage: pending,
      warnings: pending,
      toolCalls: pending,
      toolResults: pending,
      reasoning: pending,
      reasoningDetails: pending,
      providerMetadata: pending,
      request: pending,
      response: pending,
      files: pending,
      sources: pending,
    };
  }

  async function withStallBudget<T>(ms: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.BERNARD_STREAM_STALL_TIMEOUT_MS;
    process.env.BERNARD_STREAM_STALL_TIMEOUT_MS = ms;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.BERNARD_STREAM_STALL_TIMEOUT_MS;
      else process.env.BERNARD_STREAM_STALL_TIMEOUT_MS = prev;
    }
  }

  it('aborts a stream that goes silent, as a self-describing timeout', async () => {
    (streamText as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeStalledStream([{ type: 'text-delta', textDelta: 'hi' }]),
    );
    await withStallBudget('120', async () => {
      // Not a bare AbortError: the REPL renders nothing for those, so a stall
      // surfaced that way would silently swallow the turn (the #302 lesson).
      // "timed out" also earns the `timeout` category from error-taxonomy.
      await expect(runAgent(makeSpec({ useStreaming: true }))).rejects.toThrow(
        /Provider stream timed out — no data received/,
      );
    });
  });

  it('does not fire while a tool is executing', async () => {
    // `fullStream` emits `tool-call` when the model finishes emitting it, then
    // nothing until `tool-result`. A sub-agent or MCP call legitimately owns
    // minutes of that silence, so the clock pauses rather than the budget
    // being raised past it.
    (streamText as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeStalledStream([
        { type: 'text-delta', textDelta: 'hi' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'subagent', args: {} },
      ]),
    );
    await withStallBudget('120', async () => {
      const race = await Promise.race([
        runAgent(makeSpec({ useStreaming: true })).then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<string>((r) => setTimeout(() => r('still-running'), 500)),
      ]);
      expect(race).toBe('still-running');
    });
  });

  it('does not govern the non-streaming branch', async () => {
    // Two knobs, because they measure different quantities: this one bounds the
    // gap between two BYTES, and `BERNARD_DISPATCH_STALL_TIMEOUT_MS` the gap
    // between two STEP boundaries net of tool time. Tightening the first must
    // not silently tighten the second, which would cut every dispatch at an
    // inter-token budget no completion can meet.
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ text: 'slow', steps: [] }), 400)),
    );
    await withStallBudget('120', async () => {
      const result = await runAgent(makeSpec());
      expect(result.text).toBe('slow');
    });
  });

  it('is disabled by a zero budget', async () => {
    (streamText as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeStalledStream([{ type: 'text-delta', textDelta: 'hi' }]),
    );
    await withStallBudget('0', async () => {
      const race = await Promise.race([
        runAgent(makeSpec({ useStreaming: true })).then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<string>((r) => setTimeout(() => r('still-running'), 400)),
      ]);
      expect(race).toBe('still-running');
    });
  });

  /**
   * The half of the stall report that recovery actually acts on. `OutputSink`
   * is append-only with no reset, so re-issuing a dispatch that already emitted
   * a `text-delta` prints a second copy beside the first — `producedOutput` is
   * what stops that, and it is a fact only this layer can observe.
   */
  it('reports that nothing reached the sink when the stream was silent from the start', async () => {
    (streamText as unknown as ReturnType<typeof vi.fn>).mockReturnValue(makeStalledStream([]));
    await withStallBudget('60', async () => {
      const err = await runAgent(makeSpec({ useStreaming: true })).catch((e: unknown) => e);
      // The observed incident's exact shape: headers, then nothing at all.
      expect(providerStallInfo(err)).toEqual({ phase: 'stream', producedOutput: false });
      // The brand rides ALONGSIDE the name rather than replacing it — once
      // recovery gives up, the five dispatch boundaries still need the name to
      // unwind instead of handing the model a stall dressed as a tool result.
      expect((err as Error).name).toBe(DISPATCH_ABORT_NAME);
    });
  });

  it('reports that output was produced when parts flowed before the silence', async () => {
    (streamText as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeStalledStream([{ type: 'text-delta', textDelta: 'hi' }]),
    );
    await withStallBudget('60', async () => {
      const err = await runAgent(makeSpec({ useStreaming: true })).catch((e: unknown) => e);
      expect(providerStallInfo(err)).toEqual({ phase: 'stream', producedOutput: true });
    });
  });

  it('counts each step exactly once, with debug on', async () => {
    // Two hooks incremented the same counter: the always-on `stepCounter` and
    // the debug-gated observer. `step:end`'s `n` reported 2, 4, 6… and the
    // dispatch-end count was doubled — and only ever under debug, i.e. only in
    // the sessions where anyone reads it.
    (globalThis as { __debugForRunnerTest?: boolean }).__debugForRunnerTest = true;
    try {
      (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        async (opts: { onStepFinish?: (p: unknown) => Promise<void> }) => {
          const step = {
            text: '',
            toolCalls: [],
            toolResults: [],
            finishReason: 'stop',
            usage: {},
          };
          await opts.onStepFinish?.(step);
          await opts.onStepFinish?.(step);
          return { text: 'done', steps: [], response: { messages: [] }, finishReason: 'stop' };
        },
      );
      await runAgent(makeSpec());
      const ns = logCalls.filter((c) => c.label === 'step:end').map((c) => c.data.n);
      expect(ns).toEqual([1, 2]);
      const end = logCalls.find((c) => c.label === 'agent:dispatch:end');
      expect(end?.data.steps).toBe(0); // from the result, not the counter
    } finally {
      (globalThis as { __debugForRunnerTest?: boolean }).__debugForRunnerTest = false;
    }
  });

  it('reports output as produced once a step has completed, whatever branded it', async () => {
    // The transport cannot answer this. `stall-guard.ts` mints `producedOutput:
    // false` for a headers stall — true of that one HTTP request, and silent
    // about the dispatch — and `partsSeen` moves only on the streaming branch.
    // Left uncorrected, a sub-agent that stalled on step 7 is re-run from step
    // 1, re-executing six steps of tool calls including writes.
    const { markProviderStall } = await import('../../error-taxonomy.js');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (opts: { onStepFinish?: (p: unknown) => Promise<void> }) => {
        await opts.onStepFinish?.({
          text: 'partial',
          toolCalls: [],
          toolResults: [],
          finishReason: 'tool-calls',
          usage: {},
        });
        throw markProviderStall(new Error('Provider timed out — no headers.'), {
          phase: 'headers',
          producedOutput: false,
        });
      },
    );
    const err = await runAgent(makeSpec()).catch((e: unknown) => e);
    expect(providerStallInfo(err)?.producedOutput).toBe(true);
  });

  it('does not brand a dispatch timeout, which must never be retried', async () => {
    // `BERNARD_DISPATCH_TIMEOUT_MS` is a wall clock the operator set. Silently
    // re-issuing past it would defeat exactly what they asked for, so only the
    // STALL arm brands — a mutation that brands both arms fails here.
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { abortSignal?: AbortSignal }) =>
        new Promise((_r, reject) => {
          opts.abortSignal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const prev = process.env.BERNARD_DISPATCH_TIMEOUT_MS;
    process.env.BERNARD_DISPATCH_TIMEOUT_MS = '20';
    try {
      const err = await runAgent(makeSpec()).catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/Dispatch timed out/);
      expect(providerStallInfo(err)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.BERNARD_DISPATCH_TIMEOUT_MS;
      else process.env.BERNARD_DISPATCH_TIMEOUT_MS = prev;
    }
  });

  it('lets a caller shorten the stall budget, and never lengthen it', async () => {
    (streamText as unknown as ReturnType<typeof vi.fn>).mockReturnValue(makeStalledStream([]));
    // Configured 5000 ms, caller asks for 60 ms: the short one must win, or a
    // retry would sit on the full budget and the three-attempt loop would be a
    // six-minute wait.
    await withStallBudget('5000', async () => {
      await expect(runAgent(makeSpec({ useStreaming: true, stallTimeoutMs: 60 }))).rejects.toThrow(
        /no data received/,
      );
    });
    // Configured 60 ms, caller asks for 5000 ms: the short one must STILL win.
    await withStallBudget('60', async () => {
      await expect(
        runAgent(makeSpec({ useStreaming: true, stallTimeoutMs: 5000 })),
      ).rejects.toThrow(/no data received/);
    });
  });

  it('keeps a user abort reading as a user abort', async () => {
    (streamText as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      makeStalledStream([{ type: 'text-delta', textDelta: 'hi' }]),
    );
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await withStallBudget('5000', async () => {
      await expect(
        runAgent(makeSpec({ useStreaming: true, abortSignal: ac.signal })),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});

/**
 * Dispatch liveness guard (#607). The sibling above covers the streaming branch,
 * where a byte is proof of life. `generateText` offers no bytes, so a completed
 * step is the proof and the clock is paused for the step's own tool calls.
 *
 * `generateText` is mocked to a promise that never settles: the shape of a
 * dispatch whose fetch came back and whose SDK await never did, which is the one
 * failure no transport budget can see.
 */
describe('runAgent — dispatch liveness guard (non-streaming)', () => {
  beforeEach(() => __resetInFlightCalls());

  async function withDispatchBudget<T>(ms: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.BERNARD_DISPATCH_STALL_TIMEOUT_MS;
    process.env.BERNARD_DISPATCH_STALL_TIMEOUT_MS = ms;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.BERNARD_DISPATCH_STALL_TIMEOUT_MS;
      else process.env.BERNARD_DISPATCH_STALL_TIMEOUT_MS = prev;
    }
  }

  /** A `generateText` that never settles, running `onEnter` inside the dispatch ALS. */
  function stalledGenerate(onEnter?: () => void) {
    return () =>
      new Promise<never>(() => {
        onEnter?.();
      });
  }

  it('aborts a dispatch that completes no step, as a self-describing timeout', async () => {
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(stalledGenerate());
    await withDispatchBudget('120', async () => {
      // Not a bare AbortError: the REPL renders nothing for those, and the five
      // dispatch boundaries would hand the model a stall dressed as a successful
      // tool result. "timed out" also earns the `timeout` category for free.
      await expect(runAgent(makeSpec())).rejects.toThrow(/Dispatch timed out — no step completed/);
    });
  });

  it('brands the abort so recovery and the dispatch boundaries both read it', async () => {
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(stalledGenerate());
    await withDispatchBudget('120', async () => {
      const err = await runAgent(makeSpec()).catch((e: unknown) => e);
      expect((err as Error).name).toBe(DISPATCH_ABORT_NAME);
      // `phase: 'dispatch'` is its own value rather than reusing `'stream'`:
      // `stall:recovery:*` logs it, and a triage that cannot tell which guard
      // fired cannot tell a wedged SDK await from a silent socket.
      expect(providerStallInfo(err)).toEqual({ phase: 'dispatch', producedOutput: false });
    });
  });

  it('does not fire while this dispatch has a tool in flight', async () => {
    // The `ask_user` case, and the nested-sub-agent case, are the same case: a
    // legitimately unbounded wait inside a tool. Pausing is what lets the budget
    // stay at three minutes instead of having to exceed the longest sub-agent —
    // #302's acceptance criteria written the right way round.
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      stalledGenerate(() => void beginToolCall('ask_user')),
    );
    await withDispatchBudget('120', async () => {
      const race = await Promise.race([
        runAgent(makeSpec()).then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<string>((r) => setTimeout(() => r('still-running'), 500)),
      ]);
      expect(race).toBe('still-running');
    });
  });

  it('still fires while a DIFFERENT dispatch has a tool in flight', async () => {
    // The assertion that pins the keying. Counted globally, one long-running
    // tool anywhere in the process would silence every other dispatch's guard
    // for as long as it ran — four dispatches run concurrently by default, and
    // the pool exempts nested acquires entirely.
    beginToolCall('somebody-elses-web_read');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(stalledGenerate());
    await withDispatchBudget('120', async () => {
      await expect(runAgent(makeSpec())).rejects.toThrow(/Dispatch timed out/);
    });
  });

  it('a completed step is proof of life', async () => {
    // What makes the guard survive a long dispatch: every step boundary restamps
    // the clock, so a dispatch doing real work for an hour is never cut, while
    // one that stops completing steps is.
    let onStep: ((p: unknown) => Promise<void>) | undefined;
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation((args: any) => {
      onStep = args.onStepFinish;
      return new Promise<never>(() => {});
    });
    await withDispatchBudget('150', async () => {
      const beat = setInterval(() => {
        void onStep?.({ text: '', toolCalls: [], toolResults: [] });
      }, 50);
      try {
        const race = await Promise.race([
          runAgent(makeSpec()).then(
            () => 'settled',
            () => 'settled',
          ),
          new Promise<string>((r) => setTimeout(() => r('still-running'), 600)),
        ]);
        expect(race).toBe('still-running');
      } finally {
        clearInterval(beat);
      }
    });
  });

  it('is disabled by a zero budget, and a retry cannot switch it back on', async () => {
    // `stallTimeoutMs: 60` is what makes this assertion able to FAIL. Without
    // it, an off switch that silently fell back to the 180 s default would still
    // leave the dispatch running for the 400 ms this test waits — a green test
    // over a dead off switch, which a mutation check found. With it, a fallback
    // resolves `min(180000, 60)` and fires inside the window.
    //
    // It also pins the half of `AgentSpec.stallTimeoutMs`'s contract that the
    // shortening case cannot reach: a retry may only tighten a budget, so a
    // budget the user turned OFF must stay off however short the retry's ceiling
    // is. `min` alone would not give that — it depends on the `!== null` guard
    // in front of it.
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(stalledGenerate());
    await withDispatchBudget('0', async () => {
      const race = await Promise.race([
        runAgent(makeSpec({ stallTimeoutMs: 60 })).then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<string>((r) => setTimeout(() => r('still-running'), 400)),
      ]);
      expect(race).toBe('still-running');
    });
  });

  it('lets a caller shorten the budget, and never lengthen it', async () => {
    // `AgentSpec.stallTimeoutMs` is the retry ceiling, and its contract is every
    // liveness budget for the dispatch — not only the streaming one.
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(stalledGenerate());
    await withDispatchBudget('5000', async () => {
      await expect(runAgent(makeSpec({ stallTimeoutMs: 60 }))).rejects.toThrow(
        /Dispatch timed out/,
      );
    });
    await withDispatchBudget('60', async () => {
      await expect(runAgent(makeSpec({ stallTimeoutMs: 5000 }))).rejects.toThrow(
        /Dispatch timed out/,
      );
    });
  });

  it('keeps a user abort reading as a user abort', async () => {
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(stalledGenerate());
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await withDispatchBudget('5000', async () => {
      await expect(runAgent(makeSpec({ abortSignal: ac.signal }))).rejects.toMatchObject({
        name: 'AbortError',
      });
    });
  });

  it("forwards the caller's abort to the SDK while the dispatch is running", async () => {
    // The property that replaced identity in the param-parity case above. Every
    // dispatch now chains its own controller, so what has to hold is that Esc
    // still reaches `generateText` — and that the chain is torn down afterwards,
    // since the caller's signal is one turn-scoped controller shared by every
    // dispatch in the turn and a `{once}` listener nobody removes retains a
    // controller per dispatch until the turn ends.
    let forwarded: AbortSignal | undefined;
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation((args: any) => {
      forwarded = args.abortSignal;
      return new Promise<never>(() => {});
    });
    const ac = new AbortController();
    const p = runAgent(makeSpec({ abortSignal: ac.signal })).catch(() => 'aborted');
    await new Promise((r) => setTimeout(r, 10));
    expect(forwarded?.aborted).toBe(false);
    ac.abort();
    expect(forwarded?.aborted).toBe(true);
    expect(await p).toBe('aborted');

    // And the listener is gone once the dispatch has unwound.
    const before = new AbortController();
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'done',
      steps: [],
    });
    await runAgent(makeSpec({ abortSignal: before.signal }));
    let chained: AbortSignal | undefined;
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation((args: any) => {
      chained = args.abortSignal;
      return Promise.resolve({ text: 'done', steps: [] });
    });
    await runAgent(makeSpec({ abortSignal: before.signal }));
    before.abort();
    // The first dispatch's chain was released, so its controller cannot still be
    // listening; the second's was released too, which is what this observes.
    expect(chained?.aborted).toBe(false);
  });
});

describe('a caller-supplied dispatch id (#512)', () => {
  it('is the id the run is logged under', () => {
    // The whole point of the id flowing IN: `runDefinition` assembles its
    // context message before calling `runAgent`, so it has to know the id at
    // that moment to file the record under it. If the runner minted its own
    // anyway, the record would name an id that appears nowhere in the session
    // trace — the correlation the field exists for, silently broken.
    (globalThis as { __debugForRunnerTest?: boolean }).__debugForRunnerTest = true;
    return runAgent(makeSpec({ dispatchId: 'deadbeef' })).then(() => {
      const start = logCalls.find((c) => c.label === 'agent:dispatch:start');
      expect(start?.data.dispatchId).toBe('deadbeef');
      for (const call of logCalls) {
        if (call.data?.dispatchId) expect(call.data.dispatchId).toBe('deadbeef');
      }
    });
  });

  it('is minted by the runner when the caller supplies none', () => {
    (globalThis as { __debugForRunnerTest?: boolean }).__debugForRunnerTest = true;
    return runAgent(makeSpec()).then(() => {
      const start = logCalls.find((c) => c.label === 'agent:dispatch:start');
      expect(start?.data.dispatchId).toMatch(/^[0-9a-f]{8}$/);
    });
  });
});
