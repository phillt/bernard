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

vi.mock('../providers/index.js', () => ({
  getModel: vi.fn(() => ({ modelId: 'mock' })),
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
  const actual = await importOriginal() as any;
  return {
    ...actual,
    generateText: (...args: any[]) => mockGenerateText(...args),
  };
});

import { createSubAgentTool, _resetSubAgentState } from './subagent.js';
import { MemoryStore } from '../memory.js';

function makeConfig(overrides?: Partial<BernardConfig>): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    ragEnabled: true,
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
    memoryStore = new MemoryStore();
  });

  it('has correct description and execute function', () => {
    const agentTool = createSubAgentTool(makeConfig(), toolOptions, memoryStore);
    expect(agentTool).toBeDefined();
    expect(agentTool.description).toContain('sub-agent');
    expect(agentTool.execute).toBeDefined();
  });

  it('calls generateText with task in messages and maxSteps=10', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const agentTool = createSubAgentTool(makeConfig(), toolOptions, memoryStore);
    await agentTool.execute!({ task: 'List files' }, { toolCallId: '1', messages: [], abortSignal: undefined as any });
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.maxSteps).toBe(10);
    expect(call.messages[0].content).toContain('List files');
  });

  it('uses the correct model from config', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const agentTool = createSubAgentTool(makeConfig(), toolOptions, memoryStore);
    await agentTool.execute!({ task: 'test' }, { toolCallId: '1', messages: [], abortSignal: undefined as any });
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.model).toEqual({ modelId: 'mock' });
  });

  it('includes context in user message when provided', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const agentTool = createSubAgentTool(makeConfig(), toolOptions, memoryStore);
    await agentTool.execute!(
      { task: 'Analyze code', context: 'Focus on error handling' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.messages[0].content).toContain('Context: Focus on error handling');
  });

  it('returns result.text on success', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Analysis complete: all good' });
    const agentTool = createSubAgentTool(makeConfig(), toolOptions, memoryStore);
    const result = await agentTool.execute!({ task: 'test' }, { toolCallId: '1', messages: [], abortSignal: undefined as any });
    expect(result).toBe('Analysis complete: all good');
  });

  it('returns error string (not throw) on API failure', async () => {
    mockGenerateText.mockRejectedValue(new Error('API rate limit'));
    const agentTool = createSubAgentTool(makeConfig(), toolOptions, memoryStore);
    const result = await agentTool.execute!({ task: 'test' }, { toolCallId: '1', messages: [], abortSignal: undefined as any });
    expect(result).toContain('Sub-agent error:');
    expect(result).toContain('API rate limit');
  });

  it('returns error string when concurrent limit exceeded', async () => {
    // Simulate 4 agents already active by running 4 that never resolve
    let resolvers: Array<(value: any) => void> = [];
    mockGenerateText.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));

    const agentTool = createSubAgentTool(makeConfig(), toolOptions, memoryStore);
    const execOptions = { toolCallId: '1', messages: [], abortSignal: undefined as any };

    // Start 4 concurrent agents
    const promises = Array.from({ length: 4 }, (_, i) =>
      agentTool.execute!({ task: `task ${i}` }, execOptions),
    );

    // 5th should hit the limit immediately
    const result = await agentTool.execute!({ task: 'overflow' }, execOptions);
    expect(result).toContain('Maximum concurrent sub-agents');
    expect(result).toContain('4');

    // Clean up pending promises
    for (const r of resolvers) r({ text: 'done' });
    await Promise.all(promises);
  });

  it('passes abortSignal to inner generateText', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const controller = new AbortController();
    const agentTool = createSubAgentTool(makeConfig(), toolOptions, memoryStore);
    await agentTool.execute!({ task: 'test' }, { toolCallId: '1', messages: [], abortSignal: controller.signal });
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.abortSignal).toBe(controller.signal);
  });

  it('calls printSubAgentStart and printSubAgentEnd lifecycle hooks', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const agentTool = createSubAgentTool(makeConfig(), toolOptions, memoryStore);
    await agentTool.execute!({ task: 'List files' }, { toolCallId: '1', messages: [], abortSignal: undefined as any });
    expect(mockPrintSubAgentStart).toHaveBeenCalledWith(1, 'List files');
    expect(mockPrintSubAgentEnd).toHaveBeenCalledWith(1);
  });

  it('calls printSubAgentEnd even on error', async () => {
    mockGenerateText.mockRejectedValue(new Error('fail'));
    const agentTool = createSubAgentTool(makeConfig(), toolOptions, memoryStore);
    await agentTool.execute!({ task: 'test' }, { toolCallId: '1', messages: [], abortSignal: undefined as any });
    expect(mockPrintSubAgentEnd).toHaveBeenCalledWith(1);
  });

  it('assigns incrementing IDs to sub-agents', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Done' });
    const agentTool = createSubAgentTool(makeConfig(), toolOptions, memoryStore);
    const execOptions = { toolCallId: '1', messages: [], abortSignal: undefined as any };

    await agentTool.execute!({ task: 'first' }, execOptions);
    await agentTool.execute!({ task: 'second' }, execOptions);

    expect(mockPrintSubAgentStart).toHaveBeenNthCalledWith(1, 1, 'first');
    expect(mockPrintSubAgentStart).toHaveBeenNthCalledWith(2, 2, 'second');
  });
});
