import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('ai', async () => {
  // Stand-in marker classes so .isInstance() can recognise mocked errors.
  class InvalidToolArgumentsError extends Error {
    static isInstance(err: unknown): err is InvalidToolArgumentsError {
      return err instanceof InvalidToolArgumentsError;
    }
  }
  class NoSuchToolError extends Error {
    static isInstance(err: unknown): err is NoSuchToolError {
      return err instanceof NoSuchToolError;
    }
  }
  return {
    generateText: vi.fn(),
    InvalidToolArgumentsError,
    NoSuchToolError,
  };
});

vi.mock('./providers/index.js', () => ({
  getModelForConfig: vi.fn(() => 'mock-model'),
  getProviderOptionsForConfig: vi.fn(() => undefined),
}));

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
}));

// ── Deferred imports ──────────────────────────────────────────────────────────

import { makeRepairHook } from './tool-call-repair.js';

const { generateText, InvalidToolArgumentsError, NoSuchToolError } = await import('ai');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig() {
  return {
    provider: 'anthropic',
    model: 'claude-test',
    maxTokens: 4096,
  } as any;
}

function makeRepairContext(overrides: Record<string, any> = {}) {
  return {
    toolCall: {
      toolCallId: 'tc-1',
      toolName: 'shell',
      args: 'invalid json{{',
    },
    tools: { shell: { description: 'shell' }, web_read: { description: 'web' } },
    parameterSchema: vi.fn(() => ({ type: 'object', properties: { command: { type: 'string' } } })),
    messages: [{ role: 'user', content: 'do a thing' }],
    system: 'you are bernard',
    error: new (InvalidToolArgumentsError as any)('JSON parsing failed: Unterminated string at position 16602'),
    ...overrides,
  };
}

describe('makeRepairHook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a repaired tool call when the model re-emits valid args', async () => {
    vi.mocked(generateText).mockResolvedValue({
      toolCalls: [{ toolName: 'shell', args: { command: 'ls -la' } }],
    } as any);

    const hook = makeRepairHook({ config: makeConfig(), label: 'main' });
    const repaired = await hook(makeRepairContext() as any);

    expect(repaired).not.toBeNull();
    expect(repaired!.toolName).toBe('shell');
    expect(repaired!.toolCallId).toBe('tc-1');
    expect(repaired!.args).toBe(JSON.stringify({ command: 'ls -la' }));
    expect(repaired!.toolCallType).toBe('function');
    expect(vi.mocked(generateText)).toHaveBeenCalledOnce();
  });

  it('hints at file_write when the args appear to be truncated mid-string', async () => {
    vi.mocked(generateText).mockResolvedValue({
      toolCalls: [{ toolName: 'shell', args: { command: 'ls' } }],
    } as any);

    const hook = makeRepairHook({ config: makeConfig(), label: 'main' });
    await hook(makeRepairContext() as any);

    const callArgs = vi.mocked(generateText).mock.calls[0][0] as any;
    const userMessage = callArgs.messages[callArgs.messages.length - 1];
    expect(userMessage.role).toBe('user');
    expect(userMessage.content).toMatch(/file_write/);
    expect(userMessage.content).toMatch(/truncated/i);
  });

  it('hints at available tools when the model picked a nonexistent tool', async () => {
    vi.mocked(generateText).mockResolvedValue({
      toolCalls: [{ toolName: 'shell', args: { command: 'ls' } }],
    } as any);

    const ctx = makeRepairContext({
      toolCall: { toolCallId: 'tc-2', toolName: 'bogus_tool', args: '{}' },
      error: new (NoSuchToolError as any)('Tool not found: bogus_tool'),
    });

    const hook = makeRepairHook({ config: makeConfig(), label: 'main' });
    await hook(ctx as any);

    const callArgs = vi.mocked(generateText).mock.calls[0][0] as any;
    const userMessage = callArgs.messages[callArgs.messages.length - 1];
    expect(userMessage.content).toContain('does not exist');
    expect(userMessage.content).toMatch(/shell|web_read/);
    // NoSuchTool path should free toolChoice (model has to pick).
    expect(callArgs.toolChoice).toBe('auto');
  });

  it('forces the same toolName for non-NoSuchTool errors via toolChoice', async () => {
    vi.mocked(generateText).mockResolvedValue({
      toolCalls: [{ toolName: 'shell', args: { command: 'ls' } }],
    } as any);

    const hook = makeRepairHook({ config: makeConfig(), label: 'main' });
    await hook(makeRepairContext() as any);

    const callArgs = vi.mocked(generateText).mock.calls[0][0] as any;
    expect(callArgs.toolChoice).toEqual({ type: 'tool', toolName: 'shell' });
    expect(callArgs.maxSteps).toBe(1);
  });

  it('returns null when the repair generateText itself throws', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('upstream blew up'));

    const hook = makeRepairHook({ config: makeConfig(), label: 'main' });
    const result = await hook(makeRepairContext() as any);

    expect(result).toBeNull();
  });

  it('returns null when the model emits no tool calls', async () => {
    vi.mocked(generateText).mockResolvedValue({ toolCalls: [] } as any);

    const hook = makeRepairHook({ config: makeConfig(), label: 'main' });
    const result = await hook(makeRepairContext() as any);

    expect(result).toBeNull();
  });

  it('includes the parameter schema in the recovery message when available', async () => {
    vi.mocked(generateText).mockResolvedValue({
      toolCalls: [{ toolName: 'shell', args: { command: 'ls' } }],
    } as any);

    const hook = makeRepairHook({ config: makeConfig(), label: 'main' });
    await hook(makeRepairContext() as any);

    const callArgs = vi.mocked(generateText).mock.calls[0][0] as any;
    const userMessage = callArgs.messages[callArgs.messages.length - 1];
    expect(userMessage.content).toContain('Expected parameter schema');
    expect(userMessage.content).toContain('command');
  });

  it('does not throw when parameterSchema itself throws (unknown tool)', async () => {
    vi.mocked(generateText).mockResolvedValue({
      toolCalls: [{ toolName: 'shell', args: { command: 'ls' } }],
    } as any);

    const ctx = makeRepairContext({
      parameterSchema: vi.fn(() => {
        throw new Error('no such schema');
      }),
    });

    const hook = makeRepairHook({ config: makeConfig(), label: 'main' });
    const result = await hook(ctx as any);

    expect(result).not.toBeNull();
  });

  it('only invokes generateText once per failed tool call (no looping)', async () => {
    vi.mocked(generateText).mockResolvedValue({
      toolCalls: [{ toolName: 'shell', args: { command: 'ls' } }],
    } as any);

    const hook = makeRepairHook({ config: makeConfig(), label: 'main' });
    await hook(makeRepairContext() as any);

    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
  });
});
