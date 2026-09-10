import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

vi.mock('../../../providers/index.js', () => ({
  getModelForConfig: vi.fn(() => 'mock-model'),
  getProviderOptionsForConfig: vi.fn(() => undefined),
}));

vi.mock('../../../tool-call-repair.js', () => ({
  makeRepairHook: vi.fn(() => vi.fn()),
}));

// Spy on buildContextMessage so the framework-default injection assertions can
// inspect exactly what `runDefinition` passes in without needing a real
// MemoryStore.
vi.mock('../../../context-message.js', async () => {
  const actual = await vi.importActual<typeof import('../../../context-message.js')>(
    '../../../context-message.js',
  );
  return {
    ...actual,
    buildContextMessage: vi.fn(),
  };
});

import { generateText, type CoreMessage } from 'ai';
import { runDefinition } from '../run.js';
import { makeTestContext } from '../../../__tests__/agent-context.js';
import { DefinitionRegistry, definitions } from '../registry.js';
import type { AgentDefinition } from '../types.js';
import { NormalStrategy } from '../../strategies/normal.js';
import type { AgentContext } from '../../context.js';
import type { BernardConfig } from '../../../config.js';
import { buildContextMessage } from '../../../context-message.js';
import { attachMeta } from '../../tools/adapter.js';
import {
  clearDispatchContexts,
  enableDispatchContextRecording,
  getDispatchContexts,
} from '../../../dispatch-context-history.js';

function makeConfig(): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    maxSteps: 20,
    ragEnabled: false,
    theme: 'bernard',
    coordinatorMode: 'off',
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    scratchSubjectThreshold: 0.15,
    conciseMode: true,
    anthropicApiKey: 'sk-test',
    customProviders: {},
  } as BernardConfig;
}

// The shared double answers the whole narrowing surface — `asOwner` for the
// ownership fence, `scoped` for the three scope axes — which is what stops the
// NEXT such field breaking this file (#318). It broke on `asOwner` and
// `fence.test.ts` broke on `scoped`, on disjoint file sets, so neither repair
// converged. The `mcp` bag here also omitted `serverTools` and `resolveAlias`,
// both required on `AgentContextMCP`: a shape no real dispatch can be handed.
function makeCtx(): AgentContext {
  return makeTestContext({ config: makeConfig() });
}

interface FakeInput {
  text: string;
}

function fakeDefinition(
  over: Partial<AgentDefinition<FakeInput, string>> = {},
): AgentDefinition<FakeInput, string> {
  return {
    id: 'fake',
    historyMode: 'ephemeral',
    site: 'main',
    systemPrompt: () => 'SYS',
    tools: () => ({}),
    strategy: () => new NormalStrategy(),
    stepBudget: () => 7,
    buildUserMessage: (input) => ({ role: 'user', content: input.text }),
    hooks: () => [],
    repairLabel: 'main',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `mockReset` before the default, to drain the `*Once` QUEUE.
  // `clearAllMocks` clears call records and leaves queued once-values in
  // place, and a once-value outranks the base implementation — so a test
  // that queues two and consumes one hands the leftover to whichever test
  // runs next. The `toBeGreaterThanOrEqual(1)` assertion further down
  // explicitly tolerates consuming only one, so the leftover is by design.
  vi.mocked(generateText).mockReset();
  (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    text: 'final answer',
    steps: [],
    response: { messages: [] },
    finishReason: 'stop',
  });
  // Default: buildContextMessage returns null (no content) so existing tests
  // that don't care about the context message see an empty messages prefix.
  // Individual tests override this for context-message assertions.
  (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
});

describe('runDefinition records what each dispatch was given (#512)', () => {
  // `ContextViewer` reads `agent.getTurnContext()`, and `turnContext.push`
  // happens at exactly one site inside `Agent.processInput` — so no sub-agent,
  // task, specialist, delegate or cron dispatch's context assembly was recorded
  // anywhere. These pin that the runner now records one, and that it records
  // the DECISION rather than only its size.

  it('records one row per LLM call, carrying the id that call is logged under', async () => {
    // Per call rather than per dispatch is the right grain: a multi-step
    // dispatch reassembles its context every iterate, and `agent:dispatch:start`
    // is logged per call too — so the ids line up with the session trace this is
    // meant to be read beside.
    clearDispatchContexts();
    enableDispatchContextRecording();
    (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (inputs: any) => {
        inputs.onReport?.({ sections: { persistent_memory: 42 } });
        return { role: 'user', content: 'CTX' };
      },
    );
    const def = fakeDefinition({
      strategy: () => ({
        async run(sctx: any) {
          await sctx.iterate({ extra: [] });
          return sctx.iterate({ extra: [] });
        },
      }),
    });
    await runDefinition(makeCtx(), def, { text: 'hi' });

    const rows = getDispatchContexts();
    expect(rows).toHaveLength(2);
    expect(rows[0].definitionId).toBe('fake');
    expect(rows[0].sections).toEqual({ persistent_memory: 42 });
    // A real 4-byte hex id from the runner, and distinct per call.
    expect(rows[0].dispatchId).toMatch(/^[0-9a-f]{8}$/);
    expect(rows[0].dispatchId).not.toBe(rows[1].dispatchId);
  });

  it('records which memory keys were dropped, not just how many', () => {
    // "2 entries were dropped" cannot be acted on; naming them can.
    clearDispatchContexts();
    enableDispatchContextRecording();
    (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (inputs: any) => {
        inputs.onReport?.({
          sections: { persistent_memory: 10 },
          memory: { kept: ['a'], dropped: ['big-log'], usedChars: 10 },
        });
        return { role: 'user', content: 'CTX' };
      },
    );
    return runDefinition(makeCtx(), fakeDefinition(), { text: 'hi' }).then(() => {
      const [rec] = getDispatchContexts();
      expect(rec.memoryKept).toEqual(['a']);
      expect(rec.memoryDropped).toEqual(['big-log']);
    });
  });

  it('records the retrieval query, which is otherwise only a debug log', async () => {
    clearDispatchContexts();
    enableDispatchContextRecording();
    (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (inputs: any) => {
        inputs.onReport?.({ sections: {} });
        return { role: 'user', content: 'CTX' };
      },
    );
    const ctx = makeCtx();
    (ctx as any).rag = { search: async () => [] };
    const def = fakeDefinition({ retrievalQuery: (i: FakeInput) => i.text });
    await runDefinition(ctx, def, { text: 'why is the sky blue' });
    expect(getDispatchContexts()[0].retrievalQuery).toBe('why is the sky blue');
  });

  it('records NO query when nothing was retrieved for', async () => {
    // The defect the second derivation caused: the recorder re-ran the
    // definition's thunk outside `resolveRetrieval`'s guards, so a dispatch
    // with no RAG store — or one whose search threw — recorded a
    // `retrievalQuery` for a search that never happened. The field's own
    // docstring says "when it retrieved".
    clearDispatchContexts();
    enableDispatchContextRecording();
    (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (inputs: any) => {
        inputs.onReport?.({ sections: {} });
        return { role: 'user', content: 'CTX' };
      },
    );
    const def = fakeDefinition({ retrievalQuery: (i: FakeInput) => i.text });
    await runDefinition(makeCtx(), def, { text: 'why is the sky blue' });
    expect(getDispatchContexts()[0].retrievalQuery).toBeUndefined();
  });

  it("never attributes one call's context to the next call's id", async () => {
    // The report is held between assembling the message and learning the id the
    // call is logged under, so it MUST be consumed. Left in place, an iterate
    // whose own assembly produced nothing records the previous iterate's
    // sections under its own dispatch id — a row that is wrong rather than
    // missing, in the one surface that exists to answer what a dispatch was
    // given.
    clearDispatchContexts();
    enableDispatchContextRecording();
    let assemblies = 0;
    (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (inputs: any) => {
        assemblies++;
        if (assemblies > 1) return null; // second iterate: nothing to inject
        inputs.onReport?.({ sections: { persistent_memory: 42 } });
        return { role: 'user', content: 'CTX' };
      },
    );
    const def = fakeDefinition({
      strategy: () => ({
        async run(sctx: any) {
          await sctx.iterate({ extra: [] });
          return sctx.iterate({ extra: [] });
        },
      }),
    });
    await runDefinition(makeCtx(), def, { text: 'hi' });
    expect(getDispatchContexts()).toHaveLength(1);
  });

  it('records nothing when the assembly produced no message', async () => {
    // The default mock returns null, i.e. no sections at all. A row for an
    // assembly that emitted nothing is noise in the one surface that exists to
    // answer "what was this dispatch given".
    clearDispatchContexts();
    enableDispatchContextRecording();
    await runDefinition(makeCtx(), fakeDefinition(), { text: 'hi' });
    expect(getDispatchContexts()).toHaveLength(0);
  });
});

describe('runDefinition resolves the record profile once and hands it down (#508)', () => {
  // The behavioural half. A definition can declare `recordId` and the runner
  // can quietly stop resolving it, or resolve it and pass `{}` down, and every
  // unit test of `resolveDispatchProfile` stays green — the same gap
  // `tool-surface.test.ts` and `retrieval.test.ts` each close for their own
  // resolution.
  function ctxWithRecord(record: any): AgentContext {
    const ctx = makeCtx();
    (ctx.stores as any).specialists = { get: (id: string) => (id === 'r1' ? record : undefined) };
    return ctx;
  }

  it('honours a declared stepRatio through to the dispatch step budget', async () => {
    const seen: number[] = [];
    const def = fakeDefinition({
      recordId: () => 'r1',
      stepBudget: (config, _input, profile) =>
        Math.ceil(config.maxSteps * (profile.stepRatio ?? 0.5)),
    });
    const ctx = ctxWithRecord({ id: 'r1', stepRatio: 0.25 });
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (arg: any) => {
        seen.push(arg.maxSteps);
        return { text: 'ok', steps: [], response: { messages: [] }, finishReason: 'stop' };
      },
    );
    await runDefinition(ctx, def, { text: 'hi' });
    expect(seen).toEqual([5]); // 20 * 0.25, not 20 * 0.5
  });

  it('honours a declared toolSurface through to the registry the definition is handed', async () => {
    let surface: string | undefined;
    const def = fakeDefinition({
      recordId: () => 'r1',
      tools: (_ctx, _input, s) => {
        surface = s.surface;
        return {};
      },
    });
    await runDefinition(ctxWithRecord({ id: 'r1', toolSurface: 'full' }), def, { text: 'hi' });
    // `historyMode: 'ephemeral'` derives to 'worker'; the record beat it.
    expect(surface).toBe('full');
  });

  it('resolves the record ONCE per dispatch, not once per iterate', async () => {
    // `stepBudget`, `strategy` and `tools` each need the answer, and `iterate`
    // can run several times per dispatch. Reading the store per consumer would
    // be a `readFileSync` per LLM call for a value that cannot change mid-run.
    let reads = 0;
    const ctx = makeCtx();
    (ctx.stores as any).specialists = {
      get: () => {
        reads++;
        return { id: 'r1', stepRatio: 0.25 };
      },
    };
    const def = fakeDefinition({
      recordId: () => 'r1',
      strategy: () => ({
        async run(sctx: any) {
          await sctx.iterate({ extra: [] });
          await sctx.iterate({ extra: [] });
          return { text: 'done', steps: [], finishReason: 'stop' } as any;
        },
      }),
    });
    await runDefinition(ctx, def, { text: 'hi' });
    expect(reads).toBe(1);
  });

  it('a definition with no recordId is untouched, which is what keeps main safe', async () => {
    const ctx = makeCtx();
    (ctx.stores as any).specialists = {
      get: () => {
        throw new Error('must not be consulted');
      },
    };
    const profiles: unknown[] = [];
    const def = fakeDefinition({
      stepBudget: (_c, _i, profile) => {
        profiles.push(profile);
        return 7;
      },
    });
    await expect(runDefinition(ctx, def, { text: 'hi' })).resolves.toBeDefined();
    expect(profiles).toEqual([{}]);
  });
});

describe('runDefinition telemetry site attribution (#299)', () => {
  it('records off-main steps under the opts.telemetrySite label, not "main"', async () => {
    const def = fakeDefinition();
    const ctx = makeCtx();
    // Attach a stats target so the totals hook is installed. Capture the
    // HookModelInfo the hook records against by driving one step through it.
    const recorded: string[] = [];
    const spinnerStats: any = {
      startTime: 0,
      turnPromptTokens: 0,
      turnCompletionTokens: 0,
      turnCacheReadTokens: 0,
      turnCacheWriteTokens: 0,
      latestPromptTokens: 0,
      model: 'claude-x',
      turnLedger: {
        set(key: string) {
          recorded.push(key);
        },
        get: () => undefined,
        has: () => false,
      },
    };
    ctx.statsTarget = { lastStepPromptTokens: 0, spinnerStats } as any;

    // Make generateText invoke the onStepFinish hooks it was handed so the
    // totals hook actually records a step.
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (arg: any) => {
        await arg.onStepFinish?.({
          text: '',
          toolCalls: [],
          toolResults: [],
          usage: { promptTokens: 100, completionTokens: 10 },
        });
        return { text: 'done', steps: [], response: { messages: [] }, finishReason: 'stop' };
      },
    );

    await runDefinition(ctx, def, { text: 'x' }, { telemetrySite: 'mcp:google' });

    // The per-turn ledger key is `${bucket}|${provider}|${model}|${site}`.
    expect(recorded.some((k) => k.endsWith('|mcp:google'))).toBe(true);
    expect(recorded.some((k) => k.endsWith('|main'))).toBe(false);
  });
});

describe('runDefinition', () => {
  it('builds AgentSpec from definition fields and calls runAgent once for NormalStrategy', async () => {
    const def = fakeDefinition();
    const ctx = makeCtx();
    const out = await runDefinition(ctx, def, { text: 'hello' });

    expect(generateText).toHaveBeenCalledTimes(1);
    const arg = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.system).toBe('SYS');
    expect(arg.maxSteps).toBe(7);
    expect(arg.maxTokens).toBe(4096);
    expect(arg.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(out.formatted).toBe('final answer');
    expect(out.resolved.provider).toBe('anthropic');
  });

  it('reports stepLimitHit=true when the run ends at its step budget still calling tools', async () => {
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'partial',
      steps: [1, 2, 3, 4, 5, 6, 7], // == stepBudget (7)
      response: { messages: [] },
      finishReason: 'tool-calls',
    });
    const out = await runDefinition(makeCtx(), fakeDefinition(), { text: 'x' });
    expect(out.stepLimitHit).toBe(true);
  });

  it('reports stepLimitHit=false when the run finishes cleanly', async () => {
    // Default mock: finishReason 'stop'.
    const out = await runDefinition(makeCtx(), fakeDefinition(), { text: 'x' });
    expect(out.stepLimitHit).toBe(false);
  });

  it('reports stepLimitHit=false when tool-calls end below the step budget', async () => {
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'partial',
      steps: [1, 2], // < stepBudget (7)
      response: { messages: [] },
      finishReason: 'tool-calls',
    });
    const out = await runDefinition(makeCtx(), fakeDefinition(), { text: 'x' });
    expect(out.stepLimitHit).toBe(false);
  });

  it('uses seedMessages when provided instead of buildUserMessage', async () => {
    const def = fakeDefinition();
    const ctx = makeCtx();
    const seed: CoreMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ];
    await runDefinition(ctx, def, { text: 'ignored' }, { seedMessages: seed });

    const arg = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.messages).toEqual(seed);
  });

  it('applies formatResult when defined', async () => {
    const def = fakeDefinition({
      formatResult: (result) => `wrapped:${result.text}`,
    });
    const ctx = makeCtx();
    const out = await runDefinition(ctx, def, { text: 'hi' });
    expect(out.formatted).toBe('wrapped:final answer');
  });

  it('threads provider/model overrides through to model resolution', async () => {
    const def = fakeDefinition();
    const ctx = makeCtx();
    ctx.config = { ...ctx.config, openaiApiKey: 'sk-openai' } as BernardConfig;
    const out = await runDefinition(
      ctx,
      def,
      { text: 'x' },
      {
        overrides: { provider: 'openai', model: 'gpt-4o-mini' },
      },
    );
    expect(out.resolved.provider).toBe('openai');
    expect(out.resolved.modelName).toBe('gpt-4o-mini');
  });

  it('forwards abortSignal to runAgent and repair hook', async () => {
    const def = fakeDefinition();
    const ctx = makeCtx();
    const ctrl = new AbortController();
    await runDefinition(ctx, def, { text: 'x' }, { abortSignal: ctrl.signal });
    const arg = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.abortSignal).toBe(ctrl.signal);
  });
});

describe('runDefinition wrapIterate + seedMessages getter', () => {
  it('resolves seedMessages function on every iterate call (persistent history)', async () => {
    const def = fakeDefinition();
    const ctx = makeCtx();
    const history: CoreMessage[] = [{ role: 'user', content: 'first' }];

    let callCount = 0;
    const wrapIterate = (inner: any) => async (opts: any) => {
      callCount++;
      if (callCount === 1) {
        // Mutate the history reference to simulate auto-continue pushing partials.
        history.push({ role: 'assistant', content: 'partial' });
        history.push({ role: 'user', content: 'continue' });
        return inner(opts);
      }
      return inner(opts);
    };

    (generateText as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        text: '',
        steps: [],
        response: { messages: [] },
        finishReason: 'length',
      })
      .mockResolvedValueOnce({
        text: 'done',
        steps: [],
        response: { messages: [] },
        finishReason: 'stop',
      });

    await runDefinition(
      ctx,
      def,
      { text: 'x' },
      {
        seedMessages: () => history,
        wrapIterate,
      },
    );

    expect(callCount).toBeGreaterThanOrEqual(1);
    // The wrap only calls inner once per outer call; the test asserts that the
    // function-form seed picks up mutations between calls. Trigger another
    // outer iterate by using ReAct-style enforcement extras.
    const calls = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const lastMessages = calls[calls.length - 1][0].messages;
    expect(lastMessages).toEqual(history);
  });

  it('wrapIterate receives inner that can be called repeatedly with the same opts', async () => {
    const def = fakeDefinition();
    const ctx = makeCtx();
    let innerCalls = 0;
    const wrapIterate = (inner: any) => async (opts: any) => {
      innerCalls++;
      const a = await inner(opts);
      const b = await inner(opts);
      void a;
      return b;
    };

    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'ok',
      steps: [],
      response: { messages: [] },
      finishReason: 'stop',
    });

    await runDefinition(ctx, def, { text: 'x' }, { wrapIterate });
    expect(innerCalls).toBe(1);
    // inner called twice — generateText should be invoked twice
    expect((generateText as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});

describe('runDefinition retrieval (#510)', () => {
  /** A strategy that iterates twice, so per-dispatch and per-iterate differ. */
  class TwiceStrategy {
    async run(sctx: { iterate: (o: { extra: unknown[] }) => Promise<unknown> }) {
      await sctx.iterate({ extra: [] });
      return sctx.iterate({ extra: [] }) as never;
    }
  }

  function ctxWithRag(search: ReturnType<typeof vi.fn>): AgentContext {
    return { ...makeCtx(), rag: { search } } as unknown as AgentContext;
  }

  it('searches once per dispatch even when the strategy iterates twice', async () => {
    // The property the refactor exists for, and the ONLY shape that can
    // observe it: `contextInputs` runs inside `innerIterate`, so with retrieval
    // there a re-iterating strategy searched again on every pass. A
    // single-`generateText` test passes either way and proves nothing.
    const search = vi.fn().mockResolvedValue([{ fact: 'f', similarity: 1, domain: 'general' }]);
    (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await runDefinition(
      ctxWithRag(search),
      fakeDefinition({
        retrievalQuery: (input) => input.text,
        strategy: () => new TwiceStrategy() as never,
      }),
      { text: 'hi' },
    );

    expect(buildContextMessage).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('hands the retrieved results to the context message', async () => {
    const hits = [{ fact: 'recalled', similarity: 0.9, domain: 'general' }];
    const search = vi.fn().mockResolvedValue(hits);
    (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await runDefinition(
      ctxWithRag(search),
      fakeDefinition({ retrievalQuery: (input) => input.text }),
      { text: 'hi' },
    );

    const args = (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.ragResults).toEqual(hits);
  });

  it('lets a definition that supplies its own ragResults win', async () => {
    // `main` applies stickiness and provenance the runner cannot see, and
    // `cron` pre-fetches before its MCP connect. Both hand results in through
    // `contextInputs`, so the merge is `extras.ragResults ?? retrieved` — this
    // is the test that fails if that order is flipped.
    const own = [{ fact: 'from the definition', similarity: 1, domain: 'general' }];
    const search = vi
      .fn()
      .mockResolvedValue([{ fact: 'from the runner', similarity: 1, domain: 'general' }]);
    (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await runDefinition(
      ctxWithRag(search),
      fakeDefinition({
        retrievalQuery: (input) => input.text,
        contextInputs: () => ({ ragResults: own }),
      }),
      { text: 'hi' },
    );

    const args = (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.ragResults).toEqual(own);
  });

  it('does not search for a definition that declares no query', async () => {
    const search = vi.fn().mockResolvedValue([]);
    (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await runDefinition(ctxWithRag(search), fakeDefinition(), { text: 'hi' });

    expect(search).not.toHaveBeenCalled();
  });

  it('does not render a recalled block when the search throws', async () => {
    const search = vi.fn().mockRejectedValue(new Error('embedding provider unavailable'));
    (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await runDefinition(
      ctxWithRag(search),
      fakeDefinition({ retrievalQuery: (input) => input.text }),
      { text: 'hi' },
    );

    const args = (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.ragResults).toBeUndefined();
  });
});

describe('runDefinition framework-default context injection (issue #143)', () => {
  it('injects memory + scratch by default when contextInputs is omitted', async () => {
    const def = fakeDefinition(); // no contextInputs
    const ctx = makeCtx();
    const sentinel: CoreMessage = {
      role: 'user',
      content: '<system_provided_context>fake</system_provided_context>',
    };
    (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue(sentinel);

    await runDefinition(ctx, def, { text: 'hi' });

    expect(buildContextMessage).toHaveBeenCalledTimes(1);
    const callArgs = (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.memoryStore).toBe(ctx.stores.memory);
    expect(callArgs.includeScratch).toBe(true);

    const arg = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Sentinel should be inserted before the user message.
    expect(arg.messages).toEqual([sentinel, { role: 'user', content: 'hi' }]);
  });

  it('opts out entirely when contextInputs returns null', async () => {
    const def = fakeDefinition({ contextInputs: () => null });
    const ctx = makeCtx();
    // Even if buildContextMessage would return something, it should not be called.
    (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      role: 'user',
      content: 'should not appear',
    } satisfies CoreMessage);

    await runDefinition(ctx, def, { text: 'hi' });

    expect(buildContextMessage).not.toHaveBeenCalled();
    const arg = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('merges extras from contextInputs over the includeScratch default', async () => {
    const def = fakeDefinition({
      contextInputs: () => ({
        includeScratch: false,
        mcpServerNames: ['a', 'b'],
      }),
    });
    const ctx = makeCtx();
    (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await runDefinition(ctx, def, { text: 'hi' });

    expect(buildContextMessage).toHaveBeenCalledTimes(1);
    const callArgs = (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.memoryStore).toBe(ctx.stores.memory);
    expect(callArgs.includeScratch).toBe(false);
    expect(callArgs.mcpServerNames).toEqual(['a', 'b']);
  });

  it('awaits async contextInputs', async () => {
    const def = fakeDefinition({
      async contextInputs() {
        await new Promise((r) => setTimeout(r, 0));
        return { mcpServerNames: ['from-async'] };
      },
    });
    const ctx = makeCtx();

    await runDefinition(ctx, def, { text: 'hi' });

    expect(buildContextMessage).toHaveBeenCalledTimes(1);
    const callArgs = (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.mcpServerNames).toEqual(['from-async']);
    expect(callArgs.includeScratch).toBe(true);
  });

  it('drops the context message when buildContextMessage returns null even with defaults', async () => {
    const def = fakeDefinition(); // default injection
    const ctx = makeCtx();
    (buildContextMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await runDefinition(ctx, def, { text: 'hi' });

    const arg = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('runDefinition per-turn token totals hook (#234)', () => {
  function makeTarget() {
    return {
      lastStepPromptTokens: 0,
      spinnerStats: {
        startTime: 0,
        turnPromptTokens: 0,
        turnCompletionTokens: 0,
        latestPromptTokens: 0,
        turnCacheReadTokens: 0,
        turnCacheWriteTokens: 0,
        model: 'claude-x',
        turnLedger: new Map(),
        sessionCostUsd: 0,
      },
    };
  }

  // Drive the mocked generateText to invoke onStepFinish with a usage payload so
  // any composed step hooks (the appended tokenTotalsHook) actually fire.
  function mockStepWithUsage(usage: { promptTokens: number; completionTokens: number }) {
    (generateText as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (arg: any) => {
      if (arg.onStepFinish) {
        await arg.onStepFinish({
          text: '',
          toolCalls: [],
          toolResults: [],
          usage,
          response: { messages: [] },
        });
      }
      return { text: 'final answer', steps: [], response: { messages: [] }, finishReason: 'stop' };
    });
  }

  it('non-main dispatch bumps the per-turn odometer but leaves gauge + headroom alone', async () => {
    const target = makeTarget();
    const ctx = makeCtx();
    ctx.statsTarget = target as any;
    mockStepWithUsage({ promptTokens: 200, completionTokens: 30 });

    await runDefinition(ctx, fakeDefinition({ id: 'sub' }), { text: 'x' });

    expect(target.spinnerStats.turnPromptTokens).toBe(200);
    expect(target.spinnerStats.turnCompletionTokens).toBe(30);
    // Sub-agent work must not move the main-only context gauge...
    expect(target.spinnerStats.latestPromptTokens).toBe(0);
    // ...nor the main agent's compression-headroom field.
    expect(target.lastStepPromptTokens).toBe(0);
  });

  it('a fullTokenAccounting def gets the FULL stats hook (odometer + gauge + headroom)', async () => {
    const target = makeTarget();
    const ctx = makeCtx();
    ctx.statsTarget = target as any;
    mockStepWithUsage({ promptTokens: 200, completionTokens: 30 });

    // #258: runDefinition installs the token-accounting hook centrally now (it
    // has the resolved tier/site in scope). A fullTokenAccounting def (the main
    // agent) gets the *full* `tokenStatsHook`, which — unlike the totals-only
    // variant — also drives the context gauge + compression headroom.
    await runDefinition(ctx, fakeDefinition({ fullTokenAccounting: true }), { text: 'x' });

    expect(target.spinnerStats.turnPromptTokens).toBe(200);
    expect(target.spinnerStats.turnCompletionTokens).toBe(30);
    expect(target.spinnerStats.latestPromptTokens).toBe(200);
    expect(target.lastStepPromptTokens).toBe(200);
  });

  it('attributes a step to the ledger keyed by tier + model (#258)', async () => {
    const target = makeTarget();
    const ctx = makeCtx();
    ctx.statsTarget = target as any;
    mockStepWithUsage({ promptTokens: 200, completionTokens: 30 });

    await runDefinition(ctx, fakeDefinition({ id: 'sub' }), { text: 'x' });

    const rows = Array.from(target.spinnerStats.turnLedger.values());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ promptTokens: 200, completionTokens: 30, calls: 1 });
  });

  it('absent statsTarget (cron / headless) appends nothing and does not throw', async () => {
    const ctx = makeCtx(); // no statsTarget
    mockStepWithUsage({ promptTokens: 200, completionTokens: 30 });

    const out = await runDefinition(ctx, fakeDefinition({ id: 'sub' }), { text: 'x' });
    expect(out.formatted).toBe('final answer');
  });
});

describe('vision gate (#427)', () => {
  /**
   * Pins the resolved model directly. Setting `config.model` would NOT work,
   * and that is exactly what the gate exists to handle: `resolveModel` runs
   * the lineup, a specialist pin or a per-call override, so the model that
   * receives the bytes is routinely not the session's.
   */
  const textOnlyModel = {
    resolveModel: () => ({
      model: 'fake-model' as never,
      provider: 'openai',
      modelName: 'gpt-3.5-turbo',
    }),
  };

  const imageSeed = (): CoreMessage[] => [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Task: describe this' },
        { type: 'image', image: Buffer.from('png'), mimeType: 'image/png' },
      ],
    },
  ];

  // `claude-*` is vision-capable, so a capable model must be completely
  // untouched — bytes reach the model and nothing is stripped.
  it('passes an attachment through to a capable model', async () => {
    const def = fakeDefinition({
      buildUserMessage: () => imageSeed()[0],
    });
    const res = await runDefinition(makeCtx(), def, { text: 'x' });
    expect(res.result.text).toBe('final answer');
    const sent = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const last = sent.messages[sent.messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content.some((p: { type: string }) => p.type === 'image')).toBe(true);
  });

  // An ephemeral dispatch throws: nothing billed, and the five dispatch
  // boundaries shape a throw into each tool's own failure contract.
  it('refuses an ephemeral dispatch to a text-only model, before any call', async () => {
    const def = fakeDefinition({ ...textOnlyModel, buildUserMessage: () => imageSeed()[0] });
    await expect(runDefinition(makeCtx(), def, { text: 'x' })).rejects.toThrow(
      /does not accept images/,
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  /**
   * The one that matters most. `this.history` carries image parts across every
   * `/model` switch, forever — so a throw here would brick every later turn of
   * a conversation that once contained a screenshot. It sanitizes instead.
   */
  it('a persistent history with an image survives a text-only model', async () => {
    const def = fakeDefinition({ ...textOnlyModel, historyMode: 'persistent' });
    const res = await runDefinition(makeCtx(), def, { text: 'x' }, { seedMessages: imageSeed() });
    expect(res.result.text).toBe('final answer');
    const sent = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const last = sent.messages[sent.messages.length - 1];
    expect(last.content.some((p: { type: string }) => p.type === 'image')).toBe(false);
    expect(JSON.stringify(last.content)).toContain('[Image attached]');
  });

  // The gate must cost a text-only dispatch nothing but a shallow scan.
  it('leaves a text-only dispatch alone even on a text-only model', async () => {
    const res = await runDefinition(makeCtx(), fakeDefinition(textOnlyModel), { text: 'plain' });
    expect(res.result.text).toBe('final answer');
  });
});

describe('seed budget (#451)', () => {
  const hugeSeed = (): CoreMessage[] => [{ role: 'user', content: 'x'.repeat(3_000_000) }];

  /**
   * Pins the window through `config.tokenWindow` rather than relying on a
   * catalog number. Model windows move — the 4.1 family is ~1M, so a seed
   * chosen to overflow "a small model" today quietly fits tomorrow.
   */
  const smallWindow = (): AgentContext => {
    const ctx = makeCtx();
    ctx.config.tokenWindow = 32_000;
    return ctx;
  };

  it('refuses an oversized ephemeral dispatch before any provider call', async () => {
    const def = fakeDefinition({
      resolveModel: () => ({
        model: 'fake' as never,
        provider: 'openai',
        modelName: 'gpt-4.1-mini',
      }),
      buildUserMessage: () => hugeSeed()[0],
    });
    await expect(runDefinition(smallWindow(), def, { text: 'x' })).rejects.toThrow(/too large/);
    expect(generateText).not.toHaveBeenCalled();
  });

  /**
   * The main agent already runs its own preflight `emergencyTruncate` with the
   * COMPLETE prefix — the per-turn context message included, which the
   * framework check cannot see. Checking here too would double up on the one
   * definition that does not need it, using the worse estimate.
   */
  it('leaves a persistent history to its own preflight', async () => {
    const def = fakeDefinition({
      historyMode: 'persistent',
      resolveModel: () => ({
        model: 'fake' as never,
        provider: 'openai',
        modelName: 'gpt-4.1-mini',
      }),
    });
    const res = await runDefinition(
      smallWindow(),
      def,
      { text: 'x' },
      { seedMessages: hugeSeed() },
    );
    expect(res.result.text).toBe('final answer');
  });

  it('leaves an ordinary dispatch alone', async () => {
    const res = await runDefinition(smallWindow(), fakeDefinition(), { text: 'small' });
    expect(res.result.text).toBe('final answer');
  });
});

describe('DefinitionRegistry', () => {
  it('registers, looks up, and reports missing kinds', () => {
    const reg = new DefinitionRegistry();
    const def = fakeDefinition();
    reg.register(def);
    expect(reg.has('fake')).toBe(true);
    expect(reg.get('fake')).toBe(def);
    expect(reg.ids()).toEqual(['fake']);
    expect(() => reg.get('missing')).toThrow(/not found/);
  });

  it('refuses duplicate registration', () => {
    const reg = new DefinitionRegistry();
    reg.register(fakeDefinition());
    expect(() => reg.register(fakeDefinition())).toThrow(/already registered/);
  });

  it('process-wide singleton is exported and usable', () => {
    const id = `fake-singleton-${Math.random()}`;
    definitions.register(fakeDefinition({ id }));
    expect(definitions.has(id)).toBe(true);
    definitions._clear();
  });
});

/**
 * The write-scope gate is only real if `runDefinition` forwards the reader
 * (#340).
 *
 * `augmentTools` reads `getWriteScope` from ITS OWN options, not from `ctx`, so
 * a scope set on `ctx.toolOptions` and never passed on is a scope that silently
 * never applies. That is exactly what shipped in the first cut: the gate, its
 * unit tests and its integration tests all passed while the production path
 * enforced nothing — and cron had just had its `FILE_TOOLS` filter removed, so
 * the net effect was unbounded unattended writes.
 *
 * Every other test of this feature calls `augmentTools` directly and cannot see
 * that. This one drives a real tool through `runDefinition`.
 */
describe('write-scope forwarding (#340)', () => {
  it('forwards ctx.toolOptions.writeScope into the augmented tools', async () => {
    const workspace = path.join(os.tmpdir(), 'bernard-run-scope', 'ws');
    const execute = vi.fn(async () => ({ ok: true }));
    const writeTool: any = { execute, description: 'w', parameters: {} };
    attachMeta(writeTool, {
      name: 'file_write',
      kind: 'write',
      deterministic: false,
      sideEffect: 'local',
      cacheable: false,
    });

    const ctx = makeCtx();
    ctx.toolOptions = { writeScope: { workspace } } as any;

    let captured: Record<string, any> = {};
    vi.mocked(generateText).mockImplementation(async (opts: any) => {
      captured = opts.tools ?? {};
      return { text: 'done', response: { messages: [] }, steps: [] } as any;
    });

    const def = fakeDefinition({ tools: () => ({ file_write: writeTool }) as any });
    await runDefinition(ctx, def, { text: 'go' });

    // Drive the augmented tool the model would have called.
    const out = await captured.file_write.execute({ path: '/etc/passwd' }, {});
    expect(execute).not.toHaveBeenCalled();
    expect(String(out)).toContain(workspace);
  });
});
