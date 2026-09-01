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
  isDebugEnabled: () => false,
}));

const mockPrintSpecialistStart = vi.fn();
const mockPrintSpecialistEnd = vi.fn();
const mockPrintToolCall = vi.fn();
const mockPrintToolResult = vi.fn();
const mockPrintAssistantText = vi.fn();
const mockPrintWarning = vi.fn();
const mockPrintInfo = vi.fn();
const mockPrintPlan = vi.fn();
const mockPrintThought = vi.fn();
const mockPrintEvaluation = vi.fn();

vi.mock('../output.js', () => ({
  printSpecialistStart: (...args: any[]) => mockPrintSpecialistStart(...args),
  printSpecialistEnd: (...args: any[]) => mockPrintSpecialistEnd(...args),
  printToolCall: (...args: any[]) => mockPrintToolCall(...args),
  printToolResult: (...args: any[]) => mockPrintToolResult(...args),
  printAssistantText: (...args: any[]) => mockPrintAssistantText(...args),
  printWarning: (...args: any[]) => mockPrintWarning(...args),
  printInfo: (...args: any[]) => mockPrintInfo(...args),
  printPlan: (...args: any[]) => mockPrintPlan(...args),
  printThought: (...args: any[]) => mockPrintThought(...args),
  printEvaluation: (...args: any[]) => mockPrintEvaluation(...args),
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

import { createSpecialistRunTool } from './specialist-run.js';
import { detectResultFailure } from '../tool-result-shape.js';
import { _resetPool, getActiveCount } from './agent-pool.js';
import { MemoryStore } from '../memory.js';
import { SpecialistStore } from '../specialists.js';
import { assembleContext } from '../framework/context.js';

const { getModelForConfig: mockGetModel } = await import('../providers/index.js');

function makeCtx(
  config: BernardConfig,
  toolOptions: ToolOptions,
  memoryStore: MemoryStore,
  specialistStore: SpecialistStore,
  opts: { rag?: any } = {},
) {
  return assembleContext({
    config,
    toolOptions,
    rag: opts.rag,
    stores: { memory: memoryStore, specialists: specialistStore },
  });
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
    conciseMode: true,
    anthropicApiKey: 'sk-test',
    ...overrides,
  };
}

const mockSpecialist = {
  id: 'email-triage',
  name: 'Email Triage',
  description: 'Triage incoming emails',
  systemPrompt: 'You are an email triage specialist. Prioritize by urgency and sender importance.',
  guidelines: ['Always flag VIP senders', 'Use urgency levels: critical, high, normal, low'],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('specialist-run tool', () => {
  let memoryStore: MemoryStore;
  let specialistStore: SpecialistStore;
  const toolOptions: ToolOptions = {
    shellTimeout: 30000,
    confirmDangerous: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetPool();
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    memoryStore = new MemoryStore();
    specialistStore = new SpecialistStore();
  });

  it('has correct description and execute function', () => {
    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    expect(tool).toBeDefined();
    expect(tool.description).toContain('specialist');
    expect(tool.execute).toBeDefined();
  });

  it('returns error when specialist not found', async () => {
    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    const result = await tool.execute!(
      { specialistId: 'nonexistent', task: 'Do something' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(result).toContain('No specialist found');
    expect(result).toContain('nonexistent');
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('refuses to run a disabled specialist', async () => {
    vi.spyOn(specialistStore, 'get').mockReturnValue({ ...mockSpecialist, disabled: true });
    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    const result = await tool.execute!(
      { specialistId: 'email-triage', task: 'Do something' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(result).toContain('disabled');
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('calls generateText with specialist system prompt and guidelines', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    // Mock the specialist store to return our specialist
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    await tool.execute!(
      { specialistId: 'email-triage', task: 'Triage these emails' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.maxSteps).toBe(13); // Math.ceil(25 * 0.5)
    expect(call.system).toContain('email triage specialist');
    expect(call.system).toContain('Always flag VIP senders');
    expect(call.system).toContain('Use urgency levels');
    expect(call.system).toContain('NEVER simulate');
    expect(call.messages[0].content).toContain('Triage these emails');
  });

  it('includes context in user message when provided', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    await tool.execute!(
      {
        specialistId: 'email-triage',
        task: 'Triage emails',
        context: 'Focus on last 24 hours',
      },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.messages[0].content).toContain('Context: Focus on last 24 hours');
  });

  it('returns result.text on success with appended activity log', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Email triage complete: 3 urgent, 5 normal' });
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    const result = await tool.execute!(
      { specialistId: 'email-triage', task: 'Triage emails' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(result).toContain('Email triage complete: 3 urgent, 5 normal');
    expect(result).toContain('## Activity Log');
  });

  it('returns error string (not throw) on API failure', async () => {
    mockGenerateText.mockRejectedValue(new Error('API rate limit'));
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    const result = await tool.execute!(
      { specialistId: 'email-triage', task: 'Triage emails' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(result).toContain('Specialist "email-triage" failed:');
    expect(result).toContain('API rate limit');
    expect(detectResultFailure(result)).toBeDefined();
  });

  it('re-throws a cancellation instead of handing it back as a result (#327, #351)', async () => {
    // A returned string is a *successful* tool result — right for the API
    // failure above, wrong for an Esc, which the parent then reads as data and
    // keeps looping on. This site carried the re-throw since #327 but nothing
    // pinned it; the combinator (#351) is now the one place it can regress from.
    mockGenerateText.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    await expect(
      tool.execute!(
        { specialistId: 'email-triage', task: 'Triage emails' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // The unwind must not strand the pool slot it was holding.
    expect(getActiveCount()).toBe(0);
  });

  it('returns error string when concurrent limit exceeded', async () => {
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);
    const resolvers: Array<(value: any) => void> = [];
    mockGenerateText.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    const execOptions = { toolCallId: '1', messages: [], abortSignal: undefined as any };

    // Start 4 concurrent agents
    const promises = Array.from({ length: 4 }, (_, i) =>
      tool.execute!({ specialistId: 'email-triage', task: `task ${i}` }, execOptions),
    );

    // 5th should hit the limit immediately
    const result = await tool.execute!(
      { specialistId: 'email-triage', task: 'overflow' },
      execOptions,
    );
    expect(result).toContain('Maximum concurrent agents');
    expect(result).toContain('4');

    // Clean up — wait for all 4 in-flight specialists to reach the
    // generateText call (extra async hop through runDefinition) before
    // resolving them.
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

  it('calls printSpecialistStart and printSpecialistEnd lifecycle hooks', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    await tool.execute!(
      { specialistId: 'email-triage', task: 'Triage emails' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(mockPrintSpecialistStart).toHaveBeenCalledWith(1, 'Email Triage', 'Triage emails');
    expect(mockPrintSpecialistEnd).toHaveBeenCalledWith(1);
  });

  it('calls printSpecialistEnd even on error', async () => {
    mockGenerateText.mockRejectedValue(new Error('fail'));
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    await tool.execute!(
      { specialistId: 'email-triage', task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(mockPrintSpecialistEnd).toHaveBeenCalledWith(1);
  });

  it('passes abortSignal to inner generateText', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);
    const controller = new AbortController();

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    await tool.execute!(
      { specialistId: 'email-triage', task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: controller.signal },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.abortSignal).toBe(controller.signal);
  });

  it('works with specialist that has no guidelines', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const noGuidelinesSpec = { ...mockSpecialist, guidelines: [] };
    vi.spyOn(specialistStore, 'get').mockReturnValue(noGuidelinesSpec);

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    await tool.execute!(
      { specialistId: 'email-triage', task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('email triage specialist');
    expect(call.system).not.toContain('Guidelines:');
  });

  it('includes RAG context when ragStore provided', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);
    const mockRagStore = {
      search: vi
        .fn()
        .mockResolvedValue([
          { fact: 'User prefers dark mode', similarity: 0.85, domain: 'user-preferences' },
        ]),
    };

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore, {
        rag: mockRagStore as any,
      }),
    );
    await tool.execute!(
      { specialistId: 'email-triage', task: 'check preferences' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    const call = mockGenerateText.mock.calls[0][0];
    const ctx = (call.messages || [])
      .filter((m: any) => m.role === 'user' && typeof m.content === 'string')
      .map((m: any) => m.content)
      .join('\n');
    expect(ctx).toContain('<recalled_context>');
    expect(ctx).toContain('User prefers dark mode');
    expect(call.system).not.toContain('User prefers dark mode');
  });

  it('gracefully degrades when RAG search throws', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);
    const mockRagStore = {
      search: vi.fn().mockRejectedValue(new Error('embedding failed')),
    };

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore, {
        rag: mockRagStore as any,
      }),
    );
    const result = await tool.execute!(
      { specialistId: 'email-triage', task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(result).toContain('Done');
    expect(result).toContain('## Activity Log');
  });

  it('uses task text as RAG search query', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);
    const mockRagStore = {
      search: vi.fn().mockResolvedValue([]),
    };

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore, {
        rag: mockRagStore as any,
      }),
    );
    await tool.execute!(
      { specialistId: 'email-triage', task: 'triage urgent emails' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    expect(mockRagStore.search).toHaveBeenCalledWith('triage urgent emails');
  });

  it('includes error handling guidance prohibiting identical retries', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    await tool.execute!(
      { specialistId: 'email-triage', task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('NEVER retry the exact same command');
  });

  it('includes eventual consistency guidance', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

    const tool = createSpecialistRunTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
    );
    await tool.execute!(
      { specialistId: 'email-triage', task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('eventual consistency');
  });

  describe('per-agent model selection', () => {
    it('uses specialist provider/model when set', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      const specWithModel = { ...mockSpecialist, provider: 'xai', model: 'grok-code-fast-1' };
      vi.spyOn(specialistStore, 'get').mockReturnValue(specWithModel);

      const config = makeConfig({ xaiApiKey: 'xai-test' });
      const tool = createSpecialistRunTool(
        makeCtx(config, toolOptions, memoryStore, specialistStore),
      );
      await tool.execute!(
        { specialistId: 'email-triage', task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      expect(mockGetModel).toHaveBeenCalledWith(expect.anything(), 'xai', 'grok-code-fast-1');
    });

    it('invocation override takes priority over specialist config', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      const specWithModel = { ...mockSpecialist, provider: 'xai', model: 'grok-code-fast-1' };
      vi.spyOn(specialistStore, 'get').mockReturnValue(specWithModel);

      const config = makeConfig({ openaiApiKey: 'sk-openai', xaiApiKey: 'xai-test' });
      const tool = createSpecialistRunTool(
        makeCtx(config, toolOptions, memoryStore, specialistStore),
      );
      await tool.execute!(
        { specialistId: 'email-triage', task: 'test', provider: 'openai', model: 'gpt-4o-mini' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      expect(mockGetModel).toHaveBeenCalledWith(expect.anything(), 'openai', 'gpt-4o-mini');
    });

    it('falls back to global config when no overrides', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

      const tool = createSpecialistRunTool(
        makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
      );
      await tool.execute!(
        { specialistId: 'email-triage', task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      expect(mockGetModel).toHaveBeenCalledWith(
        expect.anything(),
        'anthropic',
        'claude-sonnet-4-5-20250929',
      );
    });

    it('returns error when resolved provider has no API key', async () => {
      vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

      const config = makeConfig(); // only has anthropicApiKey
      const tool = createSpecialistRunTool(
        makeCtx(config, toolOptions, memoryStore, specialistStore),
      );
      const result = await tool.execute!(
        { specialistId: 'email-triage', task: 'test', provider: 'xai' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      expect(result).toContain('No API key found');
      expect(result).toContain('xai');
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it('uses provider default model when specialist has provider but no model (avoids cross-provider mismatch)', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      // Specialist overrides provider to xai but has no model set.
      // Global config has anthropic model. Without the fix, this would try xai/claude-sonnet-4-5-20250929.
      const specProviderOnly = { ...mockSpecialist, provider: 'xai' };
      vi.spyOn(specialistStore, 'get').mockReturnValue(specProviderOnly);

      const config = makeConfig({ xaiApiKey: 'xai-test' });
      const tool = createSpecialistRunTool(
        makeCtx(config, toolOptions, memoryStore, specialistStore),
      );
      await tool.execute!(
        { specialistId: 'email-triage', task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      // Should use xai's default model, not anthropic's model
      const { getDefaultModel } = await import('../config.js');
      expect(mockGetModel).toHaveBeenCalledWith(expect.anything(), 'xai', getDefaultModel('xai'));
    });

    it('uses provider default model when invocation overrides provider but not model', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

      const config = makeConfig({ openaiApiKey: 'sk-openai' });
      const tool = createSpecialistRunTool(
        makeCtx(config, toolOptions, memoryStore, specialistStore),
      );
      await tool.execute!(
        { specialistId: 'email-triage', task: 'test', provider: 'openai' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      const { getDefaultModel } = await import('../config.js');
      expect(mockGetModel).toHaveBeenCalledWith(
        expect.anything(),
        'openai',
        getDefaultModel('openai'),
      );
    });

    it('returns error when specialist provider has no API key', async () => {
      const specWithModel = { ...mockSpecialist, provider: 'openai', model: 'gpt-4o-mini' };
      vi.spyOn(specialistStore, 'get').mockReturnValue(specWithModel);

      const config = makeConfig(); // only has anthropicApiKey
      const tool = createSpecialistRunTool(
        makeCtx(config, toolOptions, memoryStore, specialistStore),
      );
      const result = await tool.execute!(
        { specialistId: 'email-triage', task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      expect(result).toContain('No API key found');
      expect(result).toContain('openai');
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it('treats empty-string provider/model from invocation as not provided', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

      const tool = createSpecialistRunTool(
        makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
      );
      const result = await tool.execute!(
        { specialistId: 'email-triage', task: 'test', provider: '', model: '   ' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      expect(result).not.toContain('No API key found');
      expect(mockGetModel).toHaveBeenCalledWith(expect.anything(), 'anthropic', expect.any(String));
    });

    it('treats empty-string provider on saved specialist as not provided', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      const specWithBlankProvider = { ...mockSpecialist, provider: '', model: '' };
      vi.spyOn(specialistStore, 'get').mockReturnValue(specWithBlankProvider);

      const tool = createSpecialistRunTool(
        makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
      );
      const result = await tool.execute!(
        { specialistId: 'email-triage', task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      expect(result).not.toContain('No API key found');
      expect(mockGetModel).toHaveBeenCalledWith(expect.anything(), 'anthropic', expect.any(String));
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
      vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

      const tool = createSpecialistRunTool(
        makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
      );
      const result = (await tool.execute!(
        { specialistId: 'email-triage', task: 'review the PR' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      )) as string;

      expect(result).not.toBe('');
      expect(result).toContain('specialist produced no text summary');
      expect(result).toContain('## Activity Log');
      expect(result).toContain('shell');
      expect(result).toContain('review submitted');
    });

    it('emits "(no tool calls)" when text and steps are both empty', async () => {
      mockGenerateText.mockResolvedValue({ text: '', steps: [] });
      vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

      const tool = createSpecialistRunTool(
        makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
      );
      const result = (await tool.execute!(
        { specialistId: 'email-triage', task: 'noop' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      )) as string;

      expect(result).toContain('specialist produced no text summary');
      expect(result).toContain('(no tool calls)');
    });

    it('forces a text-only final step via experimental_prepareStep', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

      const tool = createSpecialistRunTool(
        makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
      );
      await tool.execute!(
        { specialistId: 'email-triage', task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      const call = mockGenerateText.mock.calls[0][0];
      expect(call.experimental_prepareStep).toBeDefined();
      // Must force toolChoice 'none' on the last step.
      const lastStep = await call.experimental_prepareStep({ stepNumber: call.maxSteps });
      expect(lastStep).toEqual({ toolChoice: 'none' });
      // Earlier steps are unaffected.
      const earlyStep = await call.experimental_prepareStep({ stepNumber: 0 });
      expect(earlyStep).toBeUndefined();
    });
  });

  describe('ReAct mode', () => {
    it('exposes plan and think tools in every run (regardless of reactMode)', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

      const tool = createSpecialistRunTool(
        makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
      );
      await tool.execute!(
        { specialistId: 'email-triage', task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      const call = mockGenerateText.mock.calls[0][0];
      expect(call.tools.plan).toBeDefined();
      expect(call.tools.think).toBeDefined();
      // evaluate is gated to reactMode
      expect(call.tools.evaluate).toBeUndefined();
    });

    it('exposes evaluate tool only when reactMode is enabled', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

      const tool = createSpecialistRunTool(
        makeCtx(makeConfig({ coordinatorMode: 'on' }), toolOptions, memoryStore, specialistStore),
      );
      await tool.execute!(
        { specialistId: 'email-triage', task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      const call = mockGenerateText.mock.calls[0][0];
      expect(call.tools.plan).toBeDefined();
      expect(call.tools.think).toBeDefined();
      expect(call.tools.evaluate).toBeDefined();
    });

    it('injects REACT_COORDINATOR_PROMPT only when reactMode is enabled', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

      const offTool = createSpecialistRunTool(
        makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
      );
      await offTool.execute!(
        { specialistId: 'email-triage', task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );
      expect(mockGenerateText.mock.calls[0][0].system).not.toContain('Coordinator Mode (Active)');

      mockGenerateText.mockClear();

      const onTool = createSpecialistRunTool(
        makeCtx(makeConfig({ coordinatorMode: 'on' }), toolOptions, memoryStore, specialistStore),
      );
      await onTool.execute!(
        { specialistId: 'email-triage', task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );
      expect(mockGenerateText.mock.calls[0][0].system).toContain('Coordinator Mode (Active)');
    });

    it('triples step budget (clamped to ceiling) when reactMode is enabled', async () => {
      mockGenerateText.mockResolvedValue({ text: 'Done' });
      vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

      const tool = createSpecialistRunTool(
        makeCtx(makeConfig({ coordinatorMode: 'on' }), toolOptions, memoryStore, specialistStore),
      );
      await tool.execute!(
        { specialistId: 'email-triage', task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      const call = mockGenerateText.mock.calls[0][0];
      // base = ceil(25 * 0.5) = 13, tripled = 39 (under the 150 ceiling)
      expect(call.maxSteps).toBe(39);
    });

    it('re-prompts when reactMode leaves plan steps unresolved, then succeeds', async () => {
      vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

      // First call: model creates a plan but never resolves it.
      mockGenerateText.mockImplementationOnce(async (opts: any) => {
        await opts.tools.plan.execute({
          action: 'create',
          steps: [{ description: 'Step A', verification: 'check it' }],
        });
        return { text: '', steps: [], response: { messages: [] } };
      });
      // Re-prompt: model resolves the step.
      mockGenerateText.mockImplementationOnce(async (opts: any) => {
        await opts.tools.plan.execute({
          action: 'update',
          id: 1,
          status: 'done',
          signoff: 'verified output',
        });
        return { text: 'All done', steps: [], response: { messages: [] } };
      });

      const tool = createSpecialistRunTool(
        makeCtx(makeConfig({ coordinatorMode: 'on' }), toolOptions, memoryStore, specialistStore),
      );
      const result = (await tool.execute!(
        { specialistId: 'email-triage', task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      )) as string;

      expect(mockGenerateText).toHaveBeenCalledTimes(2);
      expect(mockPrintWarning).toHaveBeenCalled();
      expect(result).toContain('All done');
    });

    it('auto-cancels unresolved steps after exhausting enforcement retries', async () => {
      vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

      // Every call creates an unresolved plan.
      mockGenerateText.mockImplementation(async (opts: any) => {
        if (opts.tools?.plan) {
          await opts.tools.plan
            .execute({
              action: 'create',
              steps: [{ description: 'Step A', verification: 'check' }],
            })
            .catch(() => undefined);
        }
        return { text: '', steps: [], response: { messages: [] } };
      });

      const tool = createSpecialistRunTool(
        makeCtx(makeConfig({ coordinatorMode: 'on' }), toolOptions, memoryStore, specialistStore),
      );
      await tool.execute!(
        { specialistId: 'email-triage', task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      // 1 initial call + 2 enforcement retries = 3 total
      expect(mockGenerateText).toHaveBeenCalledTimes(3);
      // Auto-cancel notice printed
      expect(mockPrintInfo).toHaveBeenCalledWith(expect.stringContaining('Auto-cancelled'));
    });

    it('does not run plan-enforcement when reactMode is off', async () => {
      vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

      mockGenerateText.mockImplementation(async (opts: any) => {
        // Even if a plan exists, no enforcement should fire when reactMode is off.
        if (opts.tools?.plan) {
          await opts.tools.plan.execute({
            action: 'create',
            steps: [{ description: 'Step A', verification: 'check' }],
          });
        }
        return { text: '', steps: [], response: { messages: [] } };
      });

      const tool = createSpecialistRunTool(
        makeCtx(makeConfig(), toolOptions, memoryStore, specialistStore),
      );
      await tool.execute!(
        { specialistId: 'email-triage', task: 'test' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(mockPrintWarning).not.toHaveBeenCalled();
    });
  });
});
