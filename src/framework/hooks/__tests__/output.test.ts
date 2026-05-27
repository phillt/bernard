import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../output.js', () => ({
  printToolCall: vi.fn(),
  printToolResult: vi.fn(),
  printAssistantText: vi.fn(),
}));

import { outputHook } from '../output.js';
import { printToolCall, printToolResult, printAssistantText } from '../../../output.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function payload(over: Partial<Parameters<NonNullable<ReturnType<typeof outputHook>['onStepFinish']>>[0]> = {}) {
  return {
    text: '',
    toolCalls: [],
    toolResults: [],
    ...over,
  };
}

describe('outputHook', () => {
  it('forwards prefix to all three printers', async () => {
    const hook = outputHook('sub:2');
    await hook.onStepFinish!(
      payload({
        text: 'hi',
        toolCalls: [{ toolName: 'shell', toolCallId: 't1', args: { command: 'ls' } }],
        toolResults: [{ toolName: 'shell', toolCallId: 't1', result: { output: 'x', is_error: false } }],
      }),
    );
    expect(printToolCall).toHaveBeenCalledWith('shell', { command: 'ls' }, 'sub:2');
    expect(printToolResult).toHaveBeenCalledWith('shell', { output: 'x', is_error: false }, 'sub:2');
    expect(printAssistantText).toHaveBeenCalledWith('hi', 'sub:2');
  });

  it('omits prefix when not provided (main agent shape)', async () => {
    const hook = outputHook();
    await hook.onStepFinish!(
      payload({
        text: 'done',
        toolCalls: [{ toolName: 'memory', toolCallId: 't1', args: { op: 'list' } }],
        toolResults: [{ toolName: 'memory', toolCallId: 't1', result: 'ok' }],
      }),
    );
    expect(printToolCall).toHaveBeenCalledWith('memory', { op: 'list' }, undefined);
    expect(printToolResult).toHaveBeenCalledWith('memory', 'ok', undefined);
    expect(printAssistantText).toHaveBeenCalledWith('done', undefined);
  });

  it('no-ops on empty step', async () => {
    const hook = outputHook('task:1');
    await hook.onStepFinish!(payload());
    expect(printToolCall).not.toHaveBeenCalled();
    expect(printToolResult).not.toHaveBeenCalled();
    expect(printAssistantText).not.toHaveBeenCalled();
  });

  it('skips printAssistantText when text is empty', async () => {
    const hook = outputHook();
    await hook.onStepFinish!(payload({ text: '', toolCalls: [{ toolName: 'shell', toolCallId: 'x', args: {} }] }));
    expect(printAssistantText).not.toHaveBeenCalled();
  });
});
