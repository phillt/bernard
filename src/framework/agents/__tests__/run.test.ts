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

import { generateText, type CoreMessage } from 'ai';
import { runDefinition } from '../run.js';
import { DefinitionRegistry, definitions } from '../registry.js';
import type { AgentDefinition } from '../types.js';
import { NormalStrategy } from '../../strategies/normal.js';
import type { AgentContext } from '../../context.js';
import type { BernardConfig } from '../../../config.js';

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
    reactMode: false,
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    anthropicApiKey: 'sk-test',
    customProviders: {},
  } as BernardConfig;
}

function makeCtx(): AgentContext {
  return {
    config: makeConfig(),
    stores: {} as any,
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
