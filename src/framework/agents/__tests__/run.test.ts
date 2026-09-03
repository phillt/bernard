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
import { DefinitionRegistry, definitions } from '../registry.js';
import type { AgentDefinition } from '../types.js';
import { NormalStrategy } from '../../strategies/normal.js';
import type { AgentContext } from '../../context.js';
import type { BernardConfig } from '../../../config.js';
import { buildContextMessage } from '../../../context-message.js';
import { attachMeta } from '../../tools/adapter.js';

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
