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

import {
  createTaskTool,
  wrapTaskResult,
  TASK_SYSTEM_PROMPT,
  TASK_STEP_RATIO,
  getTaskMaxSteps,
  makeLastStepTextOnly,
} from './task.js';
import { _resetPool } from './agent-pool.js';
import { MemoryStore } from '../memory.js';
import { RoutineStore } from '../routines.js';
import { assembleContext } from '../framework/context.js';

const { getModelForConfig: mockGetModel } = await import('../providers/index.js');

function makeCtx(
  config: BernardConfig,
  toolOptions: ToolOptions,
  memoryStore: MemoryStore,
  opts: { rag?: any; routines?: RoutineStore } = {},
) {
  return assembleContext({
    config,
    toolOptions,
    rag: opts.rag,
    stores: {
      memory: memoryStore,
      ...(opts.routines ? { routines: opts.routines } : {}),
    },
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

  it('returns error for non-JSON text', () => {
    const input = 'Found 3 files in the directory';
    expect(wrapTaskResult(input)).toEqual({
      status: 'error',
      output: 'Task did not produce valid structured output',
      details: input,
    });
  });

  it('returns error for invalid JSON', () => {
    const input = '{not valid json}';
    expect(wrapTaskResult(input)).toEqual({
      status: 'error',
      output: 'Task did not produce valid structured output',
      details: input,
    });
  });

  it('returns error for empty string', () => {
    expect(wrapTaskResult('')).toEqual({
      status: 'error',
      output: 'Task did not produce valid structured output',
      details: '',
    });
  });

  it('says it ran out of steps, not that its JSON was invalid (#370)', () => {
    // A task cut off at `maxSteps` never reaches the turn where it writes its
    // envelope, so it lands in the same fallback as a model that wrote prose.
    // Reporting the output format blames the wrong thing: the budget is the
    // fact that explains the failure, and the runner is the only party that
    // knows it.
    expect(wrapTaskResult('', { stepLimitHit: true, steps: 10 })).toEqual({
      status: 'error',
      output: 'Task ran out of steps (10) before producing a final answer',
      details: '',
    });
  });

  it('keeps the invalid-output sentinel when the limit was not hit (#370)', () => {
    // The sibling of the case above, and the reason `meta` is consulted rather
    // than assumed: prose from a task that finished is genuinely an output-format
    // failure, and that is what the caller should be told.
    expect(wrapTaskResult('Just some plain text', { stepLimitHit: false, steps: 3 })).toEqual({
      status: 'error',
      output: 'Task did not produce valid structured output',
      details: 'Just some plain text',
    });
  });

  it('leaves a valid envelope alone even when the limit was hit (#370)', () => {
    // A run may wrap up on its last step. Overriding a substantive answer with
    // a budget error would discard work that did happen.
    expect(
      wrapTaskResult('{"status":"success","output":"done"}', { stepLimitHit: true, steps: 10 }),
    ).toEqual({ status: 'success', output: 'done' });
  });

  it('returns error for JSON with invalid status value', () => {
    const input = '{"status": "partial", "output": "some data"}';
    expect(wrapTaskResult(input)).toEqual({
      status: 'error',
      output: 'Task did not produce valid structured output',
      details: input,
    });
  });

  it('extracts JSON when extra braces appear after the result', () => {
    const input = '{"status": "success", "output": "done"}\nExtra context: {key: "value"}';
    expect(wrapTaskResult(input)).toEqual({ status: 'success', output: 'done' });
  });

  it('preserves non-string output values', () => {
    const input = '{"status": "success", "output": ["file1.ts", "file2.ts"]}';
    const result = wrapTaskResult(input);
    expect(result.status).toBe('success');
    expect(result.output).toEqual(['file1.ts', 'file2.ts']);
  });

  it('handles nested JSON objects in output', () => {
    const input = '{"status": "success", "output": {"key": "value", "nested": {"deep": true}}}';
    const result = wrapTaskResult(input);
    expect(result.status).toBe('success');
    expect(result.output).toEqual({ key: 'value', nested: { deep: true } });
  });

  it('handles nested JSON with prose before it', () => {
    const input =
      'Here is the result:\n{"status": "success", "output": {"files": ["a.ts", "b.ts"]}}';
    const result = wrapTaskResult(input);
    expect(result.status).toBe('success');
    expect(result.output).toEqual({ files: ['a.ts', 'b.ts'] });
  });

  it('handles JSON with escaped quotes in strings', () => {
    const input = '{"status": "success", "output": "said \\"hello\\""}';
    const result = wrapTaskResult(input);
    expect(result.status).toBe('success');
    expect(result.output).toBe('said "hello"');
  });

  it('skips non-matching JSON blocks to find the task result', () => {
    const input = 'Tool returned: {"key": "val"}\n{"status": "success", "output": "done"}';
    const result = wrapTaskResult(input);
    expect(result.status).toBe('success');
    expect(result.output).toBe('done');
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
    const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    expect(taskTool).toBeDefined();
    expect(taskTool.description).toContain('isolated');
    expect(taskTool.description).toContain('structured JSON');
    expect(taskTool.description).toContain('limited step budget');
    expect(taskTool.execute).toBeDefined();
  });

  it('calls generateText with proportional maxSteps and prepareStep', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await taskTool.execute!(
      { task: 'List files' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.maxSteps).toBe(Math.ceil(25 * TASK_STEP_RATIO)); // 10
    expect(call.messages[0].content).toContain('List files');
    expect(call.experimental_prepareStep).toBeDefined();
  });

  it('clamps maxSteps to at least 2 for low config.maxSteps values', () => {
    expect(getTaskMaxSteps(makeConfig({ maxSteps: 2 }))).toBe(2);
    expect(getTaskMaxSteps(makeConfig({ maxSteps: 3 }))).toBe(2);
    expect(getTaskMaxSteps(makeConfig({ maxSteps: 1 }))).toBe(2);
  });

  it('prepareStep forces toolChoice none on the final step', async () => {
    const taskMaxSteps = getTaskMaxSteps(makeConfig({ maxSteps: 25 }));
    const prepareStep = makeLastStepTextOnly(taskMaxSteps);

    // Non-final step: should return undefined (no override)
    const midResult = await prepareStep({ stepNumber: 1 });
    expect(midResult).toBeUndefined();

    // Final step: should force toolChoice 'none'
    const lastResult = await prepareStep({ stepNumber: taskMaxSteps });
    expect(lastResult).toEqual({ toolChoice: 'none' });
  });

  it('returns structured JSON on success', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"found 3 files"}' });
    const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    const envelope = await taskTool.execute(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const parsed = JSON.parse(taskTool.serializeForModel(envelope) as string);
    expect(parsed.status).toBe('success');
    expect(parsed.output).toBe('found 3 files');
  });

  it('returns error for non-JSON output', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Just some plain text response' });
    const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    const envelope = await taskTool.execute(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const parsed = JSON.parse(taskTool.serializeForModel(envelope) as string);
    expect(parsed.status).toBe('error');
    expect(parsed.output).toBe('Task did not produce valid structured output');
    expect(parsed.details).toBe('Just some plain text response');
  });

  it('returns error JSON on API failure (does not throw)', async () => {
    mockGenerateText.mockRejectedValue(new Error('API rate limit'));
    const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    const envelope = await taskTool.execute(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const parsed = JSON.parse(taskTool.serializeForModel(envelope) as string);
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

    const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    const execOptions = { toolCallId: '1', messages: [], abortSignal: undefined as any };

    // Start 4 concurrent tasks
    const promises = Array.from({ length: 4 }, (_, i) =>
      taskTool.execute!({ task: `task ${i}` }, execOptions),
    );

    // 5th should hit the limit
    const envelope = await taskTool.execute({ task: 'overflow' }, execOptions);
    const parsed = JSON.parse(taskTool.serializeForModel(envelope) as string);
    expect(parsed.status).toBe('error');
    expect(parsed.output).toContain('Maximum concurrent agents');

    // Clean up — wait for all 4 in-flight tasks to reach the generateText
    // call (they go through an extra async hop in runDefinition before
    // pushing their resolver) before resolving.
    // Bounded so a regression that prevents resolvers from being pushed (e.g.
    // an exception inside one of the four prior `execute` calls) surfaces as
    // an assertion failure here instead of a CI timeout.
    for (let i = 0; i < 200 && resolvers.length < 4; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(resolvers.length).toBe(4);
    for (const r of resolvers) r({ text: '{"status":"success","output":"done"}' });
    await Promise.all(promises);
  });

  it('includes context in user message when provided', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
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
    const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await taskTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: controller.signal },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.abortSignal).toBe(controller.signal);
  });

  it('calls printTaskStart and printTaskEnd lifecycle hooks', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await taskTool.execute!(
      { task: 'List files' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(mockPrintTaskStart).toHaveBeenCalledWith('List files');
    expect(mockPrintTaskEnd).toHaveBeenCalledTimes(1);
  });

  it('calls printTaskEnd even on error', async () => {
    mockGenerateText.mockRejectedValue(new Error('fail'));
    const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await taskTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    expect(mockPrintTaskEnd).toHaveBeenCalledTimes(1);
  });

  it('uses task-specific system prompt with auto-context', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await taskTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('task executor');
    expect(call.system).toContain('limited step budget');
    expect(call.system).toContain('"status"');
    expect(call.system).toContain('Working directory:');
    expect(call.system).toContain('Available tools:');
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
      makeCtx(makeConfig(), toolOptions, memoryStore, { rag: mockRagStore as any }),
    );
    await taskTool.execute!(
      { task: 'check preferences' },
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

  it('uses task text as RAG search query', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const mockRagStore = {
      search: vi.fn().mockResolvedValue([]),
    };

    const taskTool = createTaskTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, { rag: mockRagStore as any }),
    );
    await taskTool.execute!(
      { task: 'check disk usage' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    expect(mockRagStore.search).toHaveBeenCalledWith('check disk usage');
  });

  it('uses resolved task content as RAG search query when taskId is provided', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const mockRagStore = {
      search: vi.fn().mockResolvedValue([]),
    };
    const routineStore = new RoutineStore();
    vi.spyOn(routineStore, 'get').mockReturnValue({
      id: 'task-check-issues',
      name: 'Check Issues',
      description: 'Check open issues',
      content: 'List all open GitHub issues using gh issue list',
    });

    const taskTool = createTaskTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, {
        rag: mockRagStore as any,
        routines: routineStore,
      }),
    );
    await taskTool.execute!(
      { taskId: 'task-check-issues' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    expect(mockRagStore.search).toHaveBeenCalledWith(
      'List all open GitHub issues using gh issue list',
    );
  });

  it('gracefully degrades when RAG search throws', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const mockRagStore = {
      search: vi.fn().mockRejectedValue(new Error('embedding failed')),
    };

    const taskTool = createTaskTool(
      makeCtx(makeConfig(), toolOptions, memoryStore, { rag: mockRagStore as any }),
    );
    const envelope = await taskTool.execute(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );

    const parsed = JSON.parse(taskTool.serializeForModel(envelope) as string);
    expect(parsed.status).toBe('success');
    expect(parsed.output).toBe('done');
  });

  it('includes error handling guidance', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
    const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
    await taskTool.execute!(
      { task: 'test' },
      { toolCallId: '1', messages: [], abortSignal: undefined as any },
    );
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('report the failure');
    expect(call.system).toContain('rather than retrying indefinitely');
  });

  describe('per-invocation model override', () => {
    it('uses override provider/model when specified', async () => {
      mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
      const config = makeConfig({ xaiApiKey: 'xai-test' });
      const taskTool = createTaskTool(makeCtx(config, toolOptions, memoryStore));
      await taskTool.execute!(
        { task: 'test', provider: 'xai', model: 'grok-code-fast-1' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      expect(mockGetModel).toHaveBeenCalledWith(expect.anything(), 'xai', 'grok-code-fast-1');
    });

    it('falls back to global config when no override', async () => {
      mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
      const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
      await taskTool.execute!(
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
      mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
      const config = makeConfig({ xaiApiKey: 'xai-test' });
      const taskTool = createTaskTool(makeCtx(config, toolOptions, memoryStore));
      await taskTool.execute!(
        { task: 'test', provider: 'xai' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      // Should use xai's default model, not anthropic's model
      const { getDefaultModel } = await import('../config.js');
      expect(mockGetModel).toHaveBeenCalledWith(expect.anything(), 'xai', getDefaultModel('xai'));
    });

    it('returns error JSON when override provider has no API key', async () => {
      const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
      const envelope = await taskTool.execute(
        { task: 'test', provider: 'xai' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      const parsed = JSON.parse(taskTool.serializeForModel(envelope) as string);
      expect(parsed.status).toBe('error');
      expect(parsed.output).toContain('No API key found');
      expect(parsed.output).toContain('xai');
      expect(mockGenerateText).not.toHaveBeenCalled();
    });
  });

  describe('taskId parameter', () => {
    it('uses saved task content when taskId is provided', async () => {
      mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
      const routineStore = new RoutineStore();
      vi.spyOn(routineStore, 'get').mockReturnValue({
        id: 'task-check-issues',
        name: 'Check Issues',
        description: 'Check open issues',
        content: 'List all open GitHub issues using gh issue list',
      });

      const taskTool = createTaskTool(
        makeCtx(makeConfig(), toolOptions, memoryStore, { routines: routineStore }),
      );
      await taskTool.execute!(
        { task: 'task-check-issues', taskId: 'task-check-issues' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      const call = mockGenerateText.mock.calls[0][0];
      expect(call.messages[0].content).toContain('List all open GitHub issues');
    });

    it('returns error when taskId not found', async () => {
      const routineStore = new RoutineStore();
      vi.spyOn(routineStore, 'get').mockReturnValue(undefined);

      const taskTool = createTaskTool(
        makeCtx(makeConfig(), toolOptions, memoryStore, { routines: routineStore }),
      );
      const envelope = await taskTool.execute(
        { task: 'task-nonexistent', taskId: 'task-nonexistent' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      const parsed = JSON.parse(taskTool.serializeForModel(envelope) as string);
      expect(parsed.status).toBe('error');
      expect(parsed.output).toContain('not found');
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it('works with taskId alone (no task parameter)', async () => {
      mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
      const routineStore = new RoutineStore();
      vi.spyOn(routineStore, 'get').mockReturnValue({
        id: 'task-check-issues',
        name: 'Check Issues',
        description: 'Check open issues',
        content: 'List all open GitHub issues using gh issue list',
      });

      const taskTool = createTaskTool(
        makeCtx(makeConfig(), toolOptions, memoryStore, { routines: routineStore }),
      );
      await taskTool.execute!(
        { taskId: 'task-check-issues' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      const call = mockGenerateText.mock.calls[0][0];
      expect(call.messages[0].content).toContain('List all open GitHub issues');
    });

    it('returns error when taskId references a routine that does not exist', async () => {
      const taskTool = createTaskTool(makeCtx(makeConfig(), toolOptions, memoryStore));
      const envelope = await taskTool.execute(
        { taskId: 'task-check-issues' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      const parsed = JSON.parse(taskTool.serializeForModel(envelope) as string);
      expect(parsed.status).toBe('error');
      expect(parsed.output).toContain('not found');
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it('appends task text as additional context when different from taskId', async () => {
      mockGenerateText.mockResolvedValue({ text: '{"status":"success","output":"done"}' });
      const routineStore = new RoutineStore();
      vi.spyOn(routineStore, 'get').mockReturnValue({
        id: 'task-check-issues',
        name: 'Check Issues',
        description: 'Check open issues',
        content: 'List all open GitHub issues using gh issue list',
      });

      const taskTool = createTaskTool(
        makeCtx(makeConfig(), toolOptions, memoryStore, { routines: routineStore }),
      );
      await taskTool.execute!(
        { task: 'only critical bugs', taskId: 'task-check-issues' },
        { toolCallId: '1', messages: [], abortSignal: undefined as any },
      );

      const call = mockGenerateText.mock.calls[0][0];
      expect(call.messages[0].content).toContain('List all open GitHub issues');
      expect(call.messages[0].content).toContain('only critical bugs');
    });
  });
});
