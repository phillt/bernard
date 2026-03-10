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

const mockPrintTaskStart = vi.fn();
const mockPrintTaskEnd = vi.fn();
const mockPrintToolCall = vi.fn();
const mockPrintToolResult = vi.fn();
const mockPrintAssistantText = vi.fn();

vi.mock('../output.js', () => ({
  printTaskStart: (...args: any[]) => mockPrintTaskStart(...args),
  printTaskEnd: (...args: any[]) => mockPrintTaskEnd(...args),
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

import { createTaskTool, wrapTaskResult, TASK_SYSTEM_PROMPT } from './task.js';
import { _resetPool } from './agent-pool.js';
import { MemoryStore } from '../memory.js';

function makeConfig(overrides?: Partial<BernardConfig>): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    ragEnabled: true,
    anthropicApiKey: 'sk-test',
    ...overrides,
  };
}

describe('wrapTaskResult', () => {
  it('passes through valid JSON with status and output', () => {
    const input = '{"status": "success", "output": "done"}';
    expect(wrapTaskResult(input)).toEqual({ status: 'success', output: 'done' });
  });

  it('passes through valid JSON with details', () => {
    const input = '{"status": "error", "output": "failed", "details": "timeout"}';
    expect(wrapTaskResult(input)).toEqual({
      status: 'error',
      output: 'failed',
      details: 'timeout',
    });
  });

  it('extracts JSON from text with prose before it', () => {
    const input = 'Here is the result:\n{"status": "success", "output": "3 files found"}';
    expect(wrapTaskResult(input)).toEqual({ status: 'success', output: '3 files found' });
  });

  it('wraps non-JSON text as success', () => {
    const input = 'Found 3 files in the directory';
    expect(wrapTaskResult(input)).toEqual({ status: 'success', output: input });
  });

  it('wraps invalid JSON as success', () => {
    const input = '{not valid json}';
    expect(wrapTaskResult(input)).toEqual({ status: 'success', output: input });
  });

  it('handles empty string', () => {
    expect(wrapTaskResult('')).toEqual({ status: 'success', output: '' });
  });

  it('wraps JSON with invalid status value as success', () => {
    const input = '{"status": "partial", "output": "some data"}';
    expect(wrapTaskResult(input)).toEqual({ status: 'success', output: input });
  });
});

describe('task tool', () => {
  let memoryStore: MemoryStore;
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
  });

  it('has correct description and execute function', () => {
    const taskTool = createTaskTool(makeConfig(), toolOptions, memoryStore);
    expect(taskTool).toBeDefined();
    expect(taskTool.description).toContain('isolated task');
    expect(taskTool.description).toContain('structured JSON');
    expect(taskTool.description).toContain('5-step');
    expect(taskTool.execute).toBeDefined();
  });

  it('calls generateText with maxSteps=5', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const taskTool = createTaskTool(makeConfig(), toolOptions, memoryStore);
    await taskTool.execute!(
      { task: 'List files' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.maxSteps).toBe(5);
    expect(call.messages[0].content).toContain('List files');
  });

  it('returns structured JSON on success', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"found 3 files"}' });
    const taskTool = createTaskTool(makeConfig(), toolOptions, memoryStore);
    const result = await taskTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.output).toBe('found 3 files');
  });

  it('wraps non-JSON output as success', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Just some plain text response' });
    const taskTool = createTaskTool(makeConfig(), toolOptions, memoryStore);
    const result = await taskTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.output).toBe('Just some plain text response');
  });

  it('returns error JSON on API failure (does not throw)', async () => {
    mockGenerateText.mockRejectedValue(new Error('API rate limit'));
    const taskTool = createTaskTool(makeConfig(), toolOptions, memoryStore);
    const result = await taskTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.output).toContain('API rate limit');
  });

  it('returns error JSON when concurrent limit exceeded', async () => {
    const resolvers: Array<(value: any) => void> = [];
    mockGenerateText.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const taskTool = createTaskTool(makeConfig(), toolOptions, memoryStore);
    const execOptions = { toolCallId: '1', messages: [], abortSignal: undefined as any };

    // Start 4 concurrent tasks
    const promises = Array.from({ length: 4 }, (_, i) =>
      taskTool.execute!({ task: `task ${i}` }, execOptions),
    );

    // 5th should hit the limit
    const result = await taskTool.execute!({ task: 'overflow' }, execOptions);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.output).toContain('Maximum concurrent agents');

    // Clean up
    for (const r of resolvers) r({ text: '{"status":"success","output":"done"}' });
    await Promise.all(promises);
  });

  it('includes context in user message when provided', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const taskTool = createTaskTool(makeConfig(), toolOptions, memoryStore);
    await taskTool.execute!(
      { task: 'Analyze code', context: 'Focus on error handling' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.messages[0].content).toContain('Context: Focus on error handling');
  });

  it('passes abortSignal to inner generateText', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const controller = new AbortController();
    const taskTool = createTaskTool(makeConfig(), toolOptions, memoryStore);
    await taskTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: controller.signal },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.abortSignal).toBe(controller.signal);
  });

  it('calls printTaskStart and printTaskEnd lifecycle hooks', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const taskTool = createTaskTool(makeConfig(), toolOptions, memoryStore);
    await taskTool.execute!(
      { task: 'List files' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(mockPrintTaskStart).toHaveBeenCalledWith('List files');
    expect(mockPrintTaskEnd).toHaveBeenCalledTimes(1);
  });

  it('calls printTaskEnd even on error', async () => {
    mockGenerateText.mockRejectedValue(new Error('fail'));
    const taskTool = createTaskTool(makeConfig(), toolOptions, memoryStore);
    await taskTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(mockPrintTaskEnd).toHaveBeenCalledTimes(1);
  });

  it('uses task-specific system prompt', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const taskTool = createTaskTool(makeConfig(), toolOptions, memoryStore);
    await taskTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('task executor');
    expect(call.system).toContain('5-step budget');
    expect(call.system).toContain('"status"');
  });

  it('includes RAG context when ragStore is provided', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const mockRagStore = {
      search: vi
        .fn()
        .mockResolvedValue([
          { fact: 'User prefers dark mode', similarity: 0.85, domain: 'user-preferences' },
        ]),
    };

    const taskTool = createTaskTool(
      makeConfig(),
      toolOptions,
      memoryStore,
      undefined,
      mockRagStore as any,
    );
    await taskTool.execute!(
      { task: 'check preferences' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('Recalled Context');
    expect(call.system).toContain('User prefers dark mode');
  });

  it('uses task text as RAG search query', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const mockRagStore = {
      search: vi.fn().mockResolvedValue([]),
    };

    const taskTool = createTaskTool(
      makeConfig(),
      toolOptions,
      memoryStore,
      undefined,
      mockRagStore as any,
    );
    await taskTool.execute!(
      { task: 'check disk usage' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    expect(mockRagStore.search).toHaveBeenCalledWith('check disk usage');
  });

  it('gracefully degrades when RAG search throws', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const mockRagStore = {
      search: vi.fn().mockRejectedValue(new Error('embedding failed')),
    };

    const taskTool = createTaskTool(
      makeConfig(),
      toolOptions,
      memoryStore,
      undefined,
      mockRagStore as any,
    );
    const result = await taskTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.output).toBe('done');
  });
});
