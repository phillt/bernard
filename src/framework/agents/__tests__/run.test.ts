import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { DefinitionRegistry, definitions } from '../registry.js';
import type { AgentDefinition } from '../types.js';
import { NormalStrategy } from '../../strategies/normal.js';
import type { AgentContext } from '../../context.js';
import type { BernardConfig } from '../../../config.js';
import { buildContextMessage } from '../../../context-message.js';

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
    anthropicApiKey: 'sk-test',
    customProviders: {},
  } as BernardConfig;
}

function makeCtx(): AgentContext {
  return {
    config: makeConfig(),
    stores: { memory: { fake: true } } as any,
    mcp: { tools: {}, serverNames: [] },
    toolOptions: {} as any,
  };
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
