import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (must appear before any imports that pull them in) ───────────

vi.mock('ai', () => ({
  generateText: vi.fn(),
  tool: vi.fn((def: any) => def),
}));

vi.mock('../providers/index.js', () => ({
  getModel: vi.fn(() => 'mock-model'),
}));

vi.mock('./index.js', () => ({
  createTools: vi.fn(() => ({})),
}));

vi.mock('./subagent.js', () => ({
  createSubAgentTool: vi.fn(() => ({ description: 'mock-agent' })),
}));

vi.mock('./task.js', () => ({
  createTaskTool: vi.fn(() => ({ description: 'mock-task' })),
  makeLastStepTextOnly: vi.fn(() => undefined),
}));

vi.mock('./specialist-run.js', () => ({
  createSpecialistRunTool: vi.fn(() => ({ description: 'mock-specialist-run' })),
}));

vi.mock('../output.js', () => ({
  printSpecialistStart: vi.fn(),
  printSpecialistEnd: vi.fn(),
  printToolCall: vi.fn(),
  printToolResult: vi.fn(),
  printAssistantText: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  debugLog: vi.fn(),
}));

vi.mock('../memory-context.js', () => ({
  buildMemoryContext: vi.fn(() => ''),
}));

vi.mock('./agent-pool.js', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    acquireSlot: vi.fn(() => ({ id: 1 })),
    releaseSlot: vi.fn(),
    MAX_CONCURRENT_AGENTS: 3,
  };
});

vi.mock('../config.js', () => ({
  hasProviderKey: vi.fn(() => true),
  getDefaultModel: vi.fn(() => 'default-model'),
  PROVIDER_ENV_VARS: { anthropic: 'ANTHROPIC_API_KEY' },
}));

vi.mock('../os-info.js', () => ({
  osPromptBlock: vi.fn(() => '## Host OS\n- Platform: linux'),
}));

vi.mock('../structured-output.js', () => ({
  STRUCTURED_OUTPUT_RULES: '\n\n## Output Format (STRICT)\n...',
  wrapWrapperResult: vi.fn((text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      return { status: 'ok', result: text };
    }
  }),
}));

vi.mock('../reasoning-log.js', () => ({
  appendReasoningLog: vi.fn(),
}));

// Node fs mock needed because SpecialistStore / MemoryStore read from disk.
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}));

// ── Deferred imports (after vi.mock hoisting) ─────────────────────────────────

import {
  formatExamples,
  buildChildTools,
  captureLastToolCall,
  captureToolCalls,
  createToolWrapperRunTool,
} from './tool-wrapper-run.js';
import { _resetPool } from './agent-pool.js';

const { generateText } = await import('ai');
const { acquireSlot, releaseSlot } = await import('./agent-pool.js');
const { hasProviderKey } = await import('../config.js');
const { appendReasoningLog } = await import('../reasoning-log.js');
const { wrapWrapperResult } = await import('../structured-output.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockConfig() {
  return {
    provider: 'anthropic',
    model: 'claude-test',
    maxTokens: 4096,
    maxSteps: 25,
  } as any;
}

function createMockSpecialistStore() {
  return {
    get: vi.fn(),
    list: vi.fn(() => []),
  } as any;
}

function createMockCorrectionStore() {
  return {
    enqueue: vi.fn(),
  } as any;
}

function createMockMemoryStore() {
  return {} as any;
}

function createMockOptions() {
  return {} as any;
}

/** Minimal tool-wrapper specialist fixture. */
function makeToolWrapperSpecialist(overrides: Record<string, any> = {}) {
  return {
    id: 'shell-wrapper',
    name: 'Shell Wrapper',
    description: 'Runs shell commands',
    systemPrompt: 'You run shell commands safely.',
    guidelines: ['Never delete without confirmation'],
    kind: 'tool-wrapper' as const,
    targetTools: ['shell'],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const DEFAULT_EXEC_OPTIONS = {
  toolCallId: 'test-1',
  messages: [],
  abortSignal: undefined as any,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('formatExamples', () => {
  it('returns empty string when no examples at all', () => {
    const specialist = makeToolWrapperSpecialist();
    expect(formatExamples(specialist as any)).toBe('');
  });

  it('returns empty string for explicit empty arrays', () => {
    const specialist = makeToolWrapperSpecialist({
      goodExamples: [],
      badExamples: [],
    });
    expect(formatExamples(specialist as any)).toBe('');
  });

  it('includes Good Examples section header and fields when good examples present', () => {
    const specialist = makeToolWrapperSpecialist({
      goodExamples: [{ input: 'list files', call: 'shell { command: "ls -la" }' }],
    });
    const result = formatExamples(specialist as any);
    expect(result).toContain('## Good Examples');
    expect(result).toContain('Input: list files');
    expect(result).toContain('Call: shell { command: "ls -la" }');
  });

  it('does not include Note: line when good example has no note', () => {
    const specialist = makeToolWrapperSpecialist({
      goodExamples: [{ input: 'list files', call: 'shell { command: "ls" }' }],
    });
    expect(formatExamples(specialist as any)).not.toContain('Note:');
  });

  it('includes Note: line when good example has a note', () => {
    const specialist = makeToolWrapperSpecialist({
      goodExamples: [
        { input: 'list files', call: 'shell { command: "ls -la" }', note: 'Use -la for details' },
      ],
    });
    expect(formatExamples(specialist as any)).toContain('Note: Use -la for details');
  });

  it('includes Bad Examples section header and all required fields', () => {
    const specialist = makeToolWrapperSpecialist({
      badExamples: [
        {
          input: 'delete temp',
          call: 'shell { command: "rm -rf /" }',
          error: 'dangerous path',
          fix: 'shell { command: "rm -rf /tmp/mydir" }',
        },
      ],
    });
    const result = formatExamples(specialist as any);
    expect(result).toContain('## Bad Examples');
    expect(result).toContain('Bad call: shell { command: "rm -rf /" }');
    expect(result).toContain('Error observed: dangerous path');
    expect(result).toContain('Correct approach: shell { command: "rm -rf /tmp/mydir" }');
  });

  it('does not include Note: line when bad example has no note', () => {
    const specialist = makeToolWrapperSpecialist({
      badExamples: [
        {
          input: 'delete',
          call: 'shell { command: "rm -rf /" }',
          error: 'dangerous',
          fix: 'safer command',
        },
      ],
    });
    expect(formatExamples(specialist as any)).not.toContain('Note:');
  });

  it('includes Note: line when bad example has a note', () => {
    const specialist = makeToolWrapperSpecialist({
      badExamples: [
        {
          input: 'delete',
          call: 'shell { command: "rm -rf /" }',
          error: 'dangerous',
          fix: 'safer command',
          note: 'always scope deletes',
        },
      ],
    });
    expect(formatExamples(specialist as any)).toContain('Note: always scope deletes');
  });

  it('includes both sections when both good and bad examples are present', () => {
    const specialist = makeToolWrapperSpecialist({
      goodExamples: [{ input: 'good', call: 'shell { command: "ls" }' }],
      badExamples: [
        {
          input: 'bad',
          call: 'shell { command: "rm -rf /" }',
          error: 'oops',
          fix: 'safer',
        },
      ],
    });
    const result = formatExamples(specialist as any);
    expect(result).toContain('## Good Examples');
    expect(result).toContain('## Bad Examples');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('buildChildTools', () => {
  const fullRegistry = {
    shell: { description: 'shell tool' },
    file_read_lines: { description: 'file read tool' },
    web_search: { description: 'web search tool' },
  };

  it('returns full registry when targetTools is undefined', () => {
    const specialist = makeToolWrapperSpecialist({ targetTools: undefined });
    expect(buildChildTools(specialist as any, fullRegistry)).toBe(fullRegistry);
  });

  it('returns full registry when targetTools is an empty array', () => {
    const specialist = makeToolWrapperSpecialist({ targetTools: [] });
    expect(buildChildTools(specialist as any, fullRegistry)).toBe(fullRegistry);
  });

  it('returns only the matching tools when targetTools has valid names', () => {
    const specialist = makeToolWrapperSpecialist({ targetTools: ['shell', 'web_search'] });
    const result = buildChildTools(specialist as any, fullRegistry);
    expect(Object.keys(result)).toEqual(['shell', 'web_search']);
    expect(result.shell).toBe(fullRegistry.shell);
    expect(result.web_search).toBe(fullRegistry.web_search);
    expect(result.file_read_lines).toBeUndefined();
  });

  it('silently skips targetTools names not present in the registry (returns empty object)', () => {
    const specialist = makeToolWrapperSpecialist({ targetTools: ['nonexistent_tool'] });
    const result = buildChildTools(specialist as any, fullRegistry);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('returns only matching when targetTools has a mix of matching and non-matching names', () => {
    const specialist = makeToolWrapperSpecialist({ targetTools: ['shell', 'nonexistent_tool'] });
    const result = buildChildTools(specialist as any, fullRegistry);
    expect(Object.keys(result)).toEqual(['shell']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('captureLastToolCall', () => {
  it('returns sentinel when steps is undefined', () => {
    expect(captureLastToolCall(undefined)).toBe('(no tool call)');
  });

  it('returns sentinel when steps array is empty', () => {
    expect(captureLastToolCall([])).toBe('(no tool call)');
  });

  it('returns sentinel when no step has toolCalls', () => {
    const steps = [{ toolCalls: [] }, { toolCalls: undefined }];
    expect(captureLastToolCall(steps)).toBe('(no tool call)');
  });

  it('formats a single tool call as "toolName {args…}"', () => {
    const steps = [{ toolCalls: [{ toolName: 'shell', args: { command: 'ls -la' } }] }];
    expect(captureLastToolCall(steps)).toBe('shell {"command":"ls -la"}');
  });

  it('returns the last tool call from the last step that has any', () => {
    const steps = [
      { toolCalls: [{ toolName: 'first_tool', args: { a: 1 } }] },
      { toolCalls: [] },
      {
        toolCalls: [
          { toolName: 'middle_tool', args: { b: 2 } },
          { toolName: 'last_tool', args: { c: 3 } },
        ],
      },
      { toolCalls: [] },
    ];
    // The last non-empty step is index 2; within that step, the last call is last_tool.
    expect(captureLastToolCall(steps)).toBe('last_tool {"c":3}');
  });

  it('truncates args representation to 600 chars', () => {
    const longValue = 'x'.repeat(700);
    const steps = [{ toolCalls: [{ toolName: 'shell', args: { key: longValue } }] }];
    const result = captureLastToolCall(steps);
    // "shell " + 600 chars from JSON.stringify
    expect(result.startsWith('shell ')).toBe(true);
    const argsSection = result.slice('shell '.length);
    expect(argsSection.length).toBeLessThanOrEqual(600);
  });

  it('returns "(unserializable args)" when args cannot be JSON-serialised', () => {
    const circular: any = {};
    circular.self = circular;
    const steps = [{ toolCalls: [{ toolName: 'shell', args: circular }] }];
    expect(captureLastToolCall(steps)).toBe('shell (unserializable args)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('captureToolCalls', () => {
  it('returns empty array when steps is undefined', () => {
    expect(captureToolCalls(undefined)).toEqual([]);
  });

  it('returns empty array when steps is empty', () => {
    expect(captureToolCalls([])).toEqual([]);
  });

  it('maps tool calls and their results correctly', () => {
    const steps = [
      {
        toolCalls: [{ toolName: 'shell', args: { command: 'ls' } }],
        toolResults: [{ result: 'file1.ts\nfile2.ts' }],
      },
    ];
    const result = captureToolCalls(steps);
    expect(result).toHaveLength(1);
    expect(result[0].tool).toBe('shell');
    expect(result[0].args).toEqual({ command: 'ls' });
    expect(result[0].resultPreview).toBe('file1.ts\nfile2.ts');
  });

  it('truncates resultPreview to 300 chars', () => {
    const longOutput = 'a'.repeat(500);
    const steps = [
      {
        toolCalls: [{ toolName: 'shell', args: {} }],
        toolResults: [{ result: longOutput }],
      },
    ];
    const result = captureToolCalls(steps);
    expect(result[0].resultPreview.length).toBe(300);
  });

  it('produces empty resultPreview string when toolResults entry is missing', () => {
    const steps = [
      {
        toolCalls: [
          { toolName: 'shell', args: { command: 'pwd' } },
          { toolName: 'web_search', args: { query: 'test' } },
        ],
        toolResults: [{ result: '/home/user' }],
        // second result absent
      },
    ];
    const result = captureToolCalls(steps);
    expect(result).toHaveLength(2);
    expect(result[0].resultPreview).toBe('/home/user');
    expect(result[1].resultPreview).toBe('');
  });

  it('handles multiple steps and aggregates all tool calls in order', () => {
    const steps = [
      {
        toolCalls: [{ toolName: 'tool_a', args: { x: 1 } }],
        toolResults: [{ result: 'result_a' }],
      },
      {
        toolCalls: [{ toolName: 'tool_b', args: { y: 2 } }],
        toolResults: [{ result: 'result_b' }],
      },
    ];
    const result = captureToolCalls(steps);
    expect(result).toHaveLength(2);
    expect(result[0].tool).toBe('tool_a');
    expect(result[1].tool).toBe('tool_b');
  });

  it('handles steps with no toolCalls gracefully', () => {
    const steps = [
      { toolCalls: undefined, toolResults: undefined },
      {
        toolCalls: [{ toolName: 'shell', args: {} }],
        toolResults: [{ result: 'ok' }],
      },
    ];
    const result = captureToolCalls(steps);
    expect(result).toHaveLength(1);
    expect(result[0].tool).toBe('shell');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('createToolWrapperRunTool – execute guard branches', () => {
  let config: ReturnType<typeof createMockConfig>;
  let options: ReturnType<typeof createMockOptions>;
  let memoryStore: ReturnType<typeof createMockMemoryStore>;
  let specialistStore: ReturnType<typeof createMockSpecialistStore>;
  let correctionStore: ReturnType<typeof createMockCorrectionStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetPool();

    config = createMockConfig();
    options = createMockOptions();
    memoryStore = createMockMemoryStore();
    specialistStore = createMockSpecialistStore();
    correctionStore = createMockCorrectionStore();

    // Restore sensible defaults after clearAllMocks.
    vi.mocked(acquireSlot).mockReturnValue({ id: 1 });
    vi.mocked(hasProviderKey).mockReturnValue(true);
  });

  // ── Guard: specialist not found ─────────────────────────────────────────────

  it('returns not_found error when specialist does not exist', async () => {
    specialistStore.get.mockReturnValue(undefined);

    const toolDef = createToolWrapperRunTool(
      config, options, memoryStore, specialistStore, correctionStore,
    );
    const result = await toolDef.execute(
      { specialistId: 'missing', input: 'do something' },
      DEFAULT_EXEC_OPTIONS,
    );

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('not_found');
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  // ── Guard: wrong kind (persona) ─────────────────────────────────────────────

  it('returns wrong_kind error when specialist has kind "persona"', async () => {
    specialistStore.get.mockReturnValue(makeToolWrapperSpecialist({ kind: 'persona' }));

    const toolDef = createToolWrapperRunTool(
      config, options, memoryStore, specialistStore, correctionStore,
    );
    const result = await toolDef.execute(
      { specialistId: 'shell-wrapper', input: 'do something' },
      DEFAULT_EXEC_OPTIONS,
    );

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('wrong_kind');
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  it('returns wrong_kind error when specialist has no kind (defaults to persona)', async () => {
    const { kind: _kind, ...noKindSpec } = makeToolWrapperSpecialist();
    specialistStore.get.mockReturnValue(noKindSpec);

    const toolDef = createToolWrapperRunTool(
      config, options, memoryStore, specialistStore, correctionStore,
    );
    const result = await toolDef.execute(
      { specialistId: 'shell-wrapper', input: 'do something' },
      DEFAULT_EXEC_OPTIONS,
    );

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('wrong_kind');
  });

  // ── Guard: no API key ───────────────────────────────────────────────────────

  it('returns no_api_key error when provider key is absent', async () => {
    specialistStore.get.mockReturnValue(makeToolWrapperSpecialist());
    vi.mocked(hasProviderKey).mockReturnValue(false);

    const toolDef = createToolWrapperRunTool(
      config, options, memoryStore, specialistStore, correctionStore,
    );
    const result = await toolDef.execute(
      { specialistId: 'shell-wrapper', input: 'do something' },
      DEFAULT_EXEC_OPTIONS,
    );

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('no_api_key');
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  // ── Guard: pool exhausted ────────────────────────────────────────────────────

  it('returns pool_exhausted error when no slot is available', async () => {
    specialistStore.get.mockReturnValue(makeToolWrapperSpecialist());
    vi.mocked(acquireSlot).mockReturnValue(null);

    const toolDef = createToolWrapperRunTool(
      config, options, memoryStore, specialistStore, correctionStore,
    );
    const result = await toolDef.execute(
      { specialistId: 'shell-wrapper', input: 'do something' },
      DEFAULT_EXEC_OPTIONS,
    );

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('pool_exhausted');
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it('returns parsed result and calls appendReasoningLog on successful run', async () => {
    specialistStore.get.mockReturnValue(makeToolWrapperSpecialist());
    vi.mocked(generateText).mockResolvedValue({
      text: '{"status":"ok","result":"done"}',
      steps: [],
    } as any);

    const toolDef = createToolWrapperRunTool(
      config, options, memoryStore, specialistStore, correctionStore,
    );
    const result = await toolDef.execute(
      { specialistId: 'shell-wrapper', input: 'list files' },
      DEFAULT_EXEC_OPTIONS,
    );

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('ok');
    expect(parsed.result).toBe('done');
    expect(vi.mocked(appendReasoningLog)).toHaveBeenCalledTimes(1);

    const logEntry = vi.mocked(appendReasoningLog).mock.calls[0][0];
    expect(logEntry.specialistId).toBe('shell-wrapper');
    expect(logEntry.input).toBe('list files');
    expect(logEntry.status).toBe('ok');
  });

  // ── Correction enqueue on tool-wrapper error ─────────────────────────────────

  it('enqueues a correction candidate when tool-wrapper returns status:error', async () => {
    specialistStore.get.mockReturnValue(makeToolWrapperSpecialist());
    vi.mocked(generateText).mockResolvedValue({
      text: '{"status":"error","result":"command failed","error":"exit_code_1"}',
      steps: [],
    } as any);
    vi.mocked(wrapWrapperResult).mockReturnValue({
      status: 'error',
      result: 'command failed',
      error: 'exit_code_1',
    } as any);

    const toolDef = createToolWrapperRunTool(
      config, options, memoryStore, specialistStore, correctionStore,
    );
    await toolDef.execute(
      { specialistId: 'shell-wrapper', input: 'run bad command' },
      DEFAULT_EXEC_OPTIONS,
    );

    expect(correctionStore.enqueue).toHaveBeenCalledTimes(1);
    const candidate = correctionStore.enqueue.mock.calls[0][0];
    expect(candidate.specialistId).toBe('shell-wrapper');
    expect(candidate.input).toBe('run bad command');
  });

  // ── No correction enqueue for meta specialists ────────────────────────────────

  it('does NOT enqueue a correction candidate when a meta specialist returns an error', async () => {
    specialistStore.get.mockReturnValue(makeToolWrapperSpecialist({ kind: 'meta' }));
    vi.mocked(generateText).mockResolvedValue({
      text: '{"status":"error","result":"meta error","error":"something"}',
      steps: [],
    } as any);
    vi.mocked(wrapWrapperResult).mockReturnValue({
      status: 'error',
      result: 'meta error',
      error: 'something',
    } as any);

    const toolDef = createToolWrapperRunTool(
      config, options, memoryStore, specialistStore, correctionStore,
    );
    await toolDef.execute(
      { specialistId: 'specialist-creator', input: 'create something' },
      DEFAULT_EXEC_OPTIONS,
    );

    expect(correctionStore.enqueue).not.toHaveBeenCalled();
  });

  // ── Runtime error catch ──────────────────────────────────────────────────────

  it('returns runtime_error and still calls releaseSlot when generateText throws', async () => {
    specialistStore.get.mockReturnValue(makeToolWrapperSpecialist());
    vi.mocked(generateText).mockRejectedValue(new Error('network timeout'));

    const toolDef = createToolWrapperRunTool(
      config, options, memoryStore, specialistStore, correctionStore,
    );
    const result = await toolDef.execute(
      { specialistId: 'shell-wrapper', input: 'do something' },
      DEFAULT_EXEC_OPTIONS,
    );

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('runtime_error');
    expect(parsed.result).toContain('network timeout');

    // finally block must fire even on throw
    expect(vi.mocked(releaseSlot)).toHaveBeenCalledTimes(1);
  });

  it('logs the runtime error to the reasoning log', async () => {
    specialistStore.get.mockReturnValue(makeToolWrapperSpecialist());
    vi.mocked(generateText).mockRejectedValue(new Error('api crash'));

    const toolDef = createToolWrapperRunTool(
      config, options, memoryStore, specialistStore, correctionStore,
    );
    await toolDef.execute(
      { specialistId: 'shell-wrapper', input: 'do something' },
      DEFAULT_EXEC_OPTIONS,
    );

    expect(vi.mocked(appendReasoningLog)).toHaveBeenCalledTimes(1);
    const logEntry = vi.mocked(appendReasoningLog).mock.calls[0][0];
    expect(logEntry.status).toBe('error');
    expect(logEntry.error).toBe('runtime_error');
  });

  // ── releaseSlot always called ─────────────────────────────────────────────────

  it('calls releaseSlot on success (finally block)', async () => {
    specialistStore.get.mockReturnValue(makeToolWrapperSpecialist());
    vi.mocked(generateText).mockResolvedValue({
      text: '{"status":"ok","result":"done"}',
      steps: [],
    } as any);

    const toolDef = createToolWrapperRunTool(
      config, options, memoryStore, specialistStore, correctionStore,
    );
    await toolDef.execute(
      { specialistId: 'shell-wrapper', input: 'list' },
      DEFAULT_EXEC_OPTIONS,
    );

    expect(vi.mocked(releaseSlot)).toHaveBeenCalledTimes(1);
  });

  it('calls releaseSlot exactly once whether the run succeeds or throws', async () => {
    specialistStore.get.mockReturnValue(makeToolWrapperSpecialist());

    // Run 1 – success
    vi.mocked(generateText).mockResolvedValueOnce({
      text: '{"status":"ok","result":"all good"}',
      steps: [],
    } as any);
    const toolDef = createToolWrapperRunTool(
      config, options, memoryStore, specialistStore, correctionStore,
    );
    await toolDef.execute(
      { specialistId: 'shell-wrapper', input: 'success run' },
      DEFAULT_EXEC_OPTIONS,
    );

    // Run 2 – error
    vi.mocked(generateText).mockRejectedValueOnce(new Error('crash'));
    await toolDef.execute(
      { specialistId: 'shell-wrapper', input: 'failing run' },
      DEFAULT_EXEC_OPTIONS,
    );

    expect(vi.mocked(releaseSlot)).toHaveBeenCalledTimes(2);
  });
});
