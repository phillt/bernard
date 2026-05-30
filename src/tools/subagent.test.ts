import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BernardConfig } from '../config.js';
import type { ToolOptions } from './types.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}));

const fs = await import('node:fs');

vi.mock('../providers/index.js', () => ({
  getModel: vi.fn(() => ({ modelId: 'mock' })),
  getModelForConfig: vi.fn(() => ({ modelId: 'mock' })),
  getProviderOptions: vi.fn(() => undefined),
  getProviderOptionsForConfig: vi.fn(() => undefined),
}));

vi.mock('../logger.js', () => ({
  debugLog: vi.fn(),
}));

const mockPrintSubAgentStart = vi.fn();
const mockPrintSubAgentEnd = vi.fn();
const mockPrintToolCall = vi.fn();
const mockPrintToolResult = vi.fn();
const mockPrintAssistantText = vi.fn();

vi.mock('../output.js', () => ({
  printSubAgentStart: (...args: any[]) => mockPrintSubAgentStart(...args),
  printSubAgentEnd: (...args: any[]) => mockPrintSubAgentEnd(...args),
  printToolCall: (...args: any[]) => mockPrintToolCall(...args),
  printToolResult: (...args: any[]) => mockPrintToolResult(...args),
  printAssistantText: (...args: any[]) => mockPrintAssistantText(...args),
  stopSpinner: vi.fn(),
}));

const mockGenerateText = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    generateText: (...args: any[]) => mockGenerateText(...args),
  };
});

import { createSubAgentTool, _resetSubAgentState } from './subagent.js';
import { MemoryStore } from '../memory.js';
import { assembleContext } from '../framework/context.js';

const { getModelForConfig: mockGetModel } = await import('../providers/index.js');

function makeCtx(
  config: BernardConfig,
  toolOptions: ToolOptions,
  memoryStore: MemoryStore,
  opts: { rag?: any; mcpTools?: any } = {},
) {
  return assembleContext({
    config,
    toolOptions,
    rag: opts.rag,
    mcp: opts.mcpTools ? { tools: opts.mcpTools } : undefined,
    stores: { memory: memoryStore },
  });
}

function messagesText(messages: any[] | undefined): string {
  if (!Array.isArray(messages)) return '';
  return messages
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .join('\n');
}

function makeConfig(overrides?: Partial<BernardConfig>): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    maxSteps: 25,
    ragEnabled: true,
    theme: 'bernard',
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    scratchSubjectThreshold: 0.15,
    anthropicApiKey: 'sk-test',
    ...overrides,
  };
}

describe('subagent tool', () => {
  let memoryStore: MemoryStore;
  const toolOptions: ToolOptions = {
    shellTimeout: 30000,
    confirmDangerous: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetSubAgentState();
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    memoryStore = new MemoryStore();
  });

  it('has correct description and execute function', () => {
    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    expect(agentTool).toBeDefined();
    expect(agentTool.description).toContain('sub-agent');
    expect(agentTool.description).toContain('self-contained');
    expect(agentTool.execute).toBeDefined();
  });

  it('calls generateText with task in messages and proportional maxSteps', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await agentTool.execute!(
      { task: 'List files' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.maxSteps).toBe(13); // Math.ceil(25 * 0.5)
    expect(call.messages[0].content).toContain('List files');
  });

  it('uses the correct model from config', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await agentTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.model).toEqual({ modelId: 'mock' });
  });

  it('includes context in user message when provided', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await agentTool.execute!(
      { task: 'Analyze code', context: 'Focus on error handling' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.messages[0].content).toContain('Context: Focus on error handling');
  });

  it('returns result.text on success with appended activity log', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Analysis complete: all good' });
    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    const result = await agentTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(result).toContain('Analysis complete: all good');
    expect(result).toContain('## Activity Log');
  });

  it('returns error string (not throw) on API failure', async () => {
    mockGenerateText.mockRejectedValue(new Error('API rate limit'));
    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    const result = await agentTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(result).toContain('Sub-agent error:');
    expect(result).toContain('API rate limit');
  });

  it('returns error string when concurrent limit exceeded', async () => {
    // Simulate 4 agents already active by running 4 that never resolve
    const resolvers: Array<(value: any) => void> = [];
    mockGenerateText.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    const execOptions = { toolCallId: '1', messages: [], abortSignal: undefined as any };

    // Start 4 concurrent agents
    const promises = Array.from({ length: 4 }, (_, i) =>
      agentTool.execute!({ task: `task ${i}` }, execOptions),
    );

    // 5th should hit the limit immediately
    const result = await agentTool.execute!({ task: 'overflow' }, execOptions);
    expect(result).toContain('Maximum concurrent sub-agents');
    expect(result).toContain('4');

    // Wait until all 4 prior calls have actually reached generateText. The
    // dispatch wrapper has more async hops than the old inline runner, so the
    // 5th can return its "Maximum concurrent" error before the prior 4 have
    // pushed their resolvers — without this drain, cleanup is a no-op and the
    // test hangs on Promise.all below.
    // Bounded so a regression that prevents resolvers from being pushed (e.g.
    // an exception inside one of the four prior `execute` calls) surfaces as
    // an assertion failure here instead of a CI timeout.
    for (let i = 0; i < 200 && resolvers.length < 4; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(resolvers.length).toBe(4);
    for (const r of resolvers) r({ text: 'done' });
    await Promise.all(promises);
  });

  it('passes abortSignal to inner generateText', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const controller = new AbortController();
    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await agentTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: controller.signal },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.abortSignal).toBe(controller.signal);
  });

  it('calls printSubAgentStart and printSubAgentEnd lifecycle hooks', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await agentTool.execute!(
      { task: 'List files' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(mockPrintSubAgentStart).toHaveBeenCalledWith(1, 'List files');
    expect(mockPrintSubAgentEnd).toHaveBeenCalledWith(1);
  });

  it('calls printSubAgentEnd even on error', async () => {
    mockGenerateText.mockRejectedValue(new Error('fail'));
    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await agentTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(mockPrintSubAgentEnd).toHaveBeenCalledWith(1);
  });

  it('assigns incrementing IDs to sub-agents', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    const execOptions = { toolCallId: '1', messages: [], abortSignal: undefined as any };

    await agentTool.execute!({ task: 'first' }, execOptions);
    await agentTool.execute!({ task: 'second' }, execOptions);

    expect(mockPrintSubAgentStart).toHaveBeenNthCalledWith(1, 1, 'first');
    expect(mockPrintSubAgentStart).toHaveBeenNthCalledWith(2, 2, 'second');
  });

  // --- Memory/RAG injection tests ---

  it('includes RAG context in system prompt when ragStore is provided', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const mockRagStore = {
      search: vi
        .fn()
        .mockResolvedValue([
          { fact: 'User prefers dark mode', similarity: 0.85, domain: 'user-preferences' },
        ]),
    };

    const agentTool = createSubAgentTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, { rag: mockRagStore as any }),
    );
    await agentTool.execute!(
      { task: 'check preferences' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    const call = mockGenerateText.mock.calls[0][0];
    const ctx = messagesText(call.messages);
    expect(ctx).toContain('<recalled_context>');
    expect(ctx).toContain('User prefers dark mode');
    expect(call.system).not.toContain('User prefers dark mode');
  });

  it('includes persistent memory in context message', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    vi.mocked(fs.readdirSync).mockReturnValue(['prefs.md'] as any);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('dark mode enabled');
    memoryStore = new MemoryStore();

    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await agentTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    const call = mockGenerateText.mock.calls[0][0];
    const ctx = messagesText(call.messages);
    expect(ctx).toContain('<persistent_memory>');
    expect(ctx).toContain('dark mode enabled');
    expect(call.system).not.toContain('dark mode enabled');
  });

  it('includes scratch notes in context message', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    memoryStore.writeScratch('plan', 'step 1 done');

    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await agentTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    const call = mockGenerateText.mock.calls[0][0];
    const ctx = messagesText(call.messages);
    expect(ctx).toContain('<scratch_notes>');
    expect(ctx).toContain('step 1 done');
    expect(call.system).not.toContain('step 1 done');
  });

  it('works without ragStore (graceful degradation)', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await agentTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('sub-agent of Bernard');
    expect(messagesText(call.messages)).not.toContain('<recalled_context>');
  });

  it('gracefully degrades when RAG search throws', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const mockRagStore = {
      search: vi.fn().mockRejectedValue(new Error('embedding failed')),
    };

    const agentTool = createSubAgentTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, { rag: mockRagStore as any }),
    );
    const result = await agentTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    expect(result).toContain('Done');
    expect(result).toContain('## Activity Log');
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).not.toContain('Recalled Context');
  });

  it('includes tool execution integrity rule in system prompt', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await agentTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('NEVER simulate');
    expect(call.system).toContain('Only report results you actually received');
    expect(call.system).toContain('verification command');
  });

  it('includes error handling guidance prohibiting identical retries', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await agentTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('NEVER retry the exact same command');
  });

  it('includes eventual consistency guidance', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await agentTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('eventual consistency');
  });

  it('uses task text as RAG search query', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const mockRagStore = {
      search: vi.fn().mockResolvedValue([]),
    };

    const agentTool = createSubAgentTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, { rag: mockRagStore as any }),
    );
    await agentTool.execute!(
      { task: 'check disk usage' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    expect(mockRagStore.search).toHaveBeenCalledWith('check disk usage');
  });

  describe('per-invocation model override', () => {
    it('uses override provider/model when specified', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      const config = makeConfig({ xaiApiKey: 'xai-test' });
      const agentTool = createSubAgentTool(makeCtx(config, toolOptions, memoryStore));
      await agentTool.execute!(
        { task: 'test', provider: 'xai', model: 'grok-code-fast-1' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      expect(mockGetModel).toHaveBeenCalledWith(expect.anything(), 'xai', 'grok-code-fast-1');
    });

    it('falls back to global config when no override', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
      await agentTool.execute!(
        { task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      expect(mockGetModel).toHaveBeenCalledWith(
        expect.anything(),
        'anthropic',
        'claude-sonnet-4-5-20250929',
      );
    });

    it('uses provider default model when provider overridden but model not (avoids cross-provider mismatch)', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      const config = makeConfig({ xaiApiKey: 'xai-test' });
      const agentTool = createSubAgentTool(makeCtx(config, toolOptions, memoryStore));
      await agentTool.execute!(
        { task: 'test', provider: 'xai' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      // Should use xai's default model, not anthropic's model
      const { getDefaultModel } = await import('../config.js');
      expect(mockGetModel).toHaveBeenCalledWith(expect.anything(), 'xai', getDefaultModel('xai'));
    });

    it('returns error when override provider has no API key', async () => {
      const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
      const result = await agentTool.execute!(
        { task: 'test', provider: 'xai' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      expect(result).toContain('No API key found');
      expect(result).toContain('xai');
      expect(mockGenerateText).not.toHaveBeenCalled();
    });
  });

  describe('post-run activity summary', () => {
    it('synthesizes activity log when text is empty but tool calls were made', async () => {
      mockGenerateText.mockResolvedValue({
        text: '',
        steps: [
          {
            toolCalls: [{ toolName: 'shell', args: { command: 'gh pr review --request-changes' } }],
            toolResults: [{ result: 'review submitted' }],
          },
        ],
      });

      const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
      const result = (await agentTool.execute!(
        { task: 'review the PR' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      )) as string;

      expect(result).not.toBe('');
      expect(result).toContain('subagent produced no text summary');
      expect(result).toContain('## Activity Log');
      expect(result).toContain('shell');
      expect(result).toContain('review submitted');
    });

    it('emits "(no tool calls)" when text and steps are both empty', async () => {
      mockGenerateText.mockResolvedValue({ text: '', steps: [] });

      const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
      const result = (await agentTool.execute!(
        { task: 'noop' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      )) as string;

      expect(result).toContain('subagent produced no text summary');
      expect(result).toContain('(no tool calls)');
    });

    it('forces a text-only final step via experimental_prepareStep', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });

      const agentTool = createSubAgentTool(makeCtx(makeConfig(), toolOptions, memoryStore));
      await agentTool.execute!(
        { task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      const call = mockGenerateText.mock.calls[0][0];
      expect(call.experimental_prepareStep).toBeDefined();
      const lastStep = await call.experimental_prepareStep({ stepNumber: call.maxSteps });
      expect(lastStep).toEqual({ toolChoice: 'none' });
      const earlyStep = await call.experimental_prepareStep({ stepNumber: 0 });
      expect(earlyStep).toBeUndefined();
    });
  });

  describe('PAC pipeline dispatch', () => {
    it('runs three phases when subagentPac is enabled', async () => {
      mockGenerateText
        .mockResolvedValueOnce({ text: 'PLAN_TEXT' })
        .mockResolvedValueOnce({ text: 'ACTOR_TEXT' })
        .mockResolvedValueOnce({ text: '{"verdict":"pass","reason":"ok"}' });

      const agentTool = createSubAgentTool(
        makeCtx(makeConfig({ subagentPac: true }), toolOptions, memoryStore),
      );
      const result = (await agentTool.execute!(
        { task: 'Do thing' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      )) as string;

      expect(mockGenerateText).toHaveBeenCalledTimes(3);
      expect(result).toContain('ACTOR_TEXT');
      expect(result).not.toContain('Critic Verdict: FAIL');
    });

    it('runs a single agent loop when subagentPac is disabled (legacy path)', async () => {
      mockGenerateText.mockResolvedValue({ text: 'LEGACY_TEXT' });

      const agentTool = createSubAgentTool(
        makeCtx(makeConfig({ subagentPac: false }), toolOptions, memoryStore),
      );
      await agentTool.execute!(
        { task: 'Do thing' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });
  });
});
