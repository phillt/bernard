import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../output.js', () => ({
  printToolCall: vi.fn(),
  printToolResult: vi.fn(),
  printAssistantText: vi.fn(),
}));

import { outputHook } from '../output.js';
import { setOutputSink, type OutputSink, type StreamEvent } from '../output-sink.js';
import { printToolCall, printToolResult, printAssistantText } from '../../../output.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  setOutputSink(null);
});

function payload(
  over: Partial<Parameters<NonNullable<ReturnType<typeof outputHook>['onStepFinish']>>[0]> = {},
) {
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
        toolResults: [
          { toolName: 'shell', toolCallId: 't1', result: { output: 'x', is_error: false } },
        ],
      }),
    );
    expect(printToolCall).toHaveBeenCalledWith('shell', { command: 'ls' }, 'sub:2');
    expect(printToolResult).toHaveBeenCalledWith(
      'shell',
      { output: 'x', is_error: false },
      'sub:2',
    );
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
    await hook.onStepFinish!(
      payload({ text: '', toolCalls: [{ toolName: 'shell', toolCallId: 'x', args: {} }] }),
    );
    expect(printAssistantText).not.toHaveBeenCalled();
  });

  describe('with an OutputSink registered', () => {
    function makeRecordingSink(): { sink: OutputSink; events: StreamEvent[] } {
      const events: StreamEvent[] = [];
      return { sink: { append: (e) => events.push(e) }, events };
    }

    it('routes step events to the sink instead of stdout', async () => {
      const { sink, events } = makeRecordingSink();
      setOutputSink(sink);
      const hook = outputHook('sub:2');
      await hook.onStepFinish!(
        payload({
          text: 'subtree summary',
          toolCalls: [{ toolName: 'shell', toolCallId: 't1', args: { command: 'ls' } }],
          toolResults: [
            { toolName: 'shell', toolCallId: 't1', result: { output: 'x', is_error: false } },
          ],
        }),
      );
      expect(printToolCall).not.toHaveBeenCalled();
      expect(printToolResult).not.toHaveBeenCalled();
      expect(printAssistantText).not.toHaveBeenCalled();
      expect(events).toEqual([
        {
          kind: 'tool-call',
          callId: 't1',
          toolName: 'shell',
          args: { command: 'ls' },
          agentLabel: 'sub:2',
        },
        {
          kind: 'tool-result',
          callId: 't1',
          result: { output: 'x', is_error: false },
          isError: false,
          agentLabel: 'sub:2',
        },
        { kind: 'text-delta', text: 'subtree summary', agentLabel: 'sub:2' },
      ]);
    });

    it('omits the bulk text-delta for the main agent (prefix === undefined)', async () => {
      const { sink, events } = makeRecordingSink();
      setOutputSink(sink);
      const hook = outputHook();
      await hook.onStepFinish!(
        payload({
          text: 'main reply',
          toolCalls: [{ toolName: 'memory', toolCallId: 'm1', args: { op: 'list' } }],
          toolResults: [{ toolName: 'memory', toolCallId: 'm1', result: 'ok' }],
        }),
      );
      // Tool events still flow (the runner needs them for inline rendering),
      // but text is suppressed here because the runner's streamText loop is
      // already pushing per-token deltas for the main agent.
      expect(events.map((e) => e.kind)).toEqual(['tool-call', 'tool-result']);
    });

    it('falls through to stdout when sink is cleared mid-test', async () => {
      const { sink } = makeRecordingSink();
      setOutputSink(sink);
      setOutputSink(null);
      const hook = outputHook();
      await hook.onStepFinish!(payload({ text: 'fallback', toolCalls: [], toolResults: [] }));
      expect(printAssistantText).toHaveBeenCalledWith('fallback', undefined);
    });
  });
});
