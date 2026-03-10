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
}));

vi.mock('../logger.js', () => ({
  debugLog: vi.fn(),
}));

const mockPrintSpecialistStart = vi.fn();
const mockPrintSpecialistEnd = vi.fn();
const mockPrintToolCall = vi.fn();
const mockPrintToolResult = vi.fn();
const mockPrintAssistantText = vi.fn();

vi.mock('../output.js', () => ({
  printSpecialistStart: (...args: any[]) => mockPrintSpecialistStart(...args),
  printSpecialistEnd: (...args: any[]) => mockPrintSpecialistEnd(...args),
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

import { createSpecialistRunTool } from './specialist-run.js';
import { _resetPool } from './agent-pool.js';
import { MemoryStore } from '../memory.js';
import { SpecialistStore } from '../specialists.js';

function makeConfig(overrides?: Partial<BernardConfig>): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    ragEnabled: true,
    theme: 'bernard',
    criticMode: false,
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
    const tool = createSpecialistRunTool(makeConfig(), toolOptions, memoryStore, specialistStore);
    expect(tool).toBeDefined();
    expect(tool.description).toContain('specialist');
    expect(tool.execute).toBeDefined();
  });

  it('returns error when specialist not found', async () => {
    const tool = createSpecialistRunTool(makeConfig(), toolOptions, memoryStore, specialistStore);
    const result = await tool.execute!(
      { specialistId: 'nonexistent', task: 'Do something' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(result).toContain('No specialist found');
    expect(result).toContain('nonexistent');
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('calls generateText with specialist system prompt and guidelines', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    // Mock the specialist store to return our specialist
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

    const tool = createSpecialistRunTool(makeConfig(), toolOptions, memoryStore, specialistStore);
    await tool.execute!(
      { specialistId: 'email-triage', task: 'Triage these emails' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.maxSteps).toBe(10);
    expect(call.system).toContain('email triage specialist');
    expect(call.system).toContain('Always flag VIP senders');
    expect(call.system).toContain('Use urgency levels');
    expect(call.system).toContain('NEVER simulate');
    expect(call.messages[0].content).toContain('Triage these emails');
  });

  it('includes context in user message when provided', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

    const tool = createSpecialistRunTool(makeConfig(), toolOptions, memoryStore, specialistStore);
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

  it('returns result.text on success', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Email triage complete: 3 urgent, 5 normal' });
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

    const tool = createSpecialistRunTool(makeConfig(), toolOptions, memoryStore, specialistStore);
    const result = await tool.execute!(
      { specialistId: 'email-triage', task: 'Triage emails' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(result).toBe('Email triage complete: 3 urgent, 5 normal');
  });

  it('returns error string (not throw) on API failure', async () => {
    mockGenerateText.mockRejectedValue(new Error('API rate limit'));
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

    const tool = createSpecialistRunTool(makeConfig(), toolOptions, memoryStore, specialistStore);
    const result = await tool.execute!(
      { specialistId: 'email-triage', task: 'Triage emails' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(result).toContain('Specialist error:');
    expect(result).toContain('API rate limit');
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

    const tool = createSpecialistRunTool(makeConfig(), toolOptions, memoryStore, specialistStore);
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

    // Clean up pending promises
    for (const r of resolvers) r({ text: 'done' });
    await Promise.all(promises);
  });

  it('calls printSpecialistStart and printSpecialistEnd lifecycle hooks', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);

    const tool = createSpecialistRunTool(makeConfig(), toolOptions, memoryStore, specialistStore);
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

    const tool = createSpecialistRunTool(makeConfig(), toolOptions, memoryStore, specialistStore);
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

    const tool = createSpecialistRunTool(makeConfig(), toolOptions, memoryStore, specialistStore);
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

    const tool = createSpecialistRunTool(makeConfig(), toolOptions, memoryStore, specialistStore);
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
      makeConfig(),
      toolOptions,
      memoryStore,
      specialistStore,
      undefined,
      mockRagStore as any,
    );
    await tool.execute!(
      { specialistId: 'email-triage', task: 'check preferences' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('Recalled Context');
    expect(call.system).toContain('User prefers dark mode');
  });

  it('gracefully degrades when RAG search throws', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);
    const mockRagStore = {
      search: vi.fn().mockRejectedValue(new Error('embedding failed')),
    };

    const tool = createSpecialistRunTool(
      makeConfig(),
      toolOptions,
      memoryStore,
      specialistStore,
      undefined,
      mockRagStore as any,
    );
    const result = await tool.execute!(
      { specialistId: 'email-triage', task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(result).toBe('Done');
  });

  it('uses task text as RAG search query', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    vi.spyOn(specialistStore, 'get').mockReturnValue(mockSpecialist);
    const mockRagStore = {
      search: vi.fn().mockResolvedValue([]),
    };

    const tool = createSpecialistRunTool(
      makeConfig(),
      toolOptions,
      memoryStore,
      specialistStore,
      undefined,
      mockRagStore as any,
    );
    await tool.execute!(
      { specialistId: 'email-triage', task: 'triage urgent emails' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    expect(mockRagStore.search).toHaveBeenCalledWith('triage urgent emails');
  });
});
