import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { outputHook } from '../output.js';
import { setOutputSink, type OutputSink, type StreamEvent } from '../output-sink.js';

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

function makeRecordingSink(): { sink: OutputSink; events: StreamEvent[] } {
  const events: StreamEvent[] = [];
  return { sink: { append: (e) => events.push(e) }, events };
}

describe('outputHook', () => {
  let recorder: { sink: OutputSink; events: StreamEvent[] };

  beforeEach(() => {
    recorder = makeRecordingSink();
    setOutputSink(recorder.sink);
  });

  afterEach(() => {
    setOutputSink(null);
  });

  it('routes step events to the sink with prefix', async () => {
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
    expect(recorder.events).toEqual([
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
    const hook = outputHook();
    await hook.onStepFinish!(
      payload({
        text: 'main reply',
        toolCalls: [{ toolName: 'memory', toolCallId: 'm1', args: { op: 'list' } }],
        toolResults: [{ toolName: 'memory', toolCallId: 'm1', result: 'ok' }],
      }),
    );
    // Tool events flow; text is suppressed here because the runner's
    // streamText loop is already pushing per-token deltas for the main agent.
    expect(recorder.events.map((e) => e.kind)).toEqual(['tool-call', 'tool-result']);
  });

  it('no-ops on empty step', async () => {
    const hook = outputHook('task:1');
    await hook.onStepFinish!(payload());
    expect(recorder.events).toEqual([]);
  });

  it('no-ops entirely when no sink is registered', async () => {
    setOutputSink(null);
    const hook = outputHook();
    await hook.onStepFinish!(
      payload({
        text: 'lost in the void',
        toolCalls: [{ toolName: 'shell', toolCallId: 'x', args: {} }],
      }),
    );
    expect(recorder.events).toEqual([]);
  });
});
