import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import type { CoreMessage } from 'ai';
import { Thread } from '../Thread.js';
import { MessageStore } from '../message-store.js';

describe('<Thread>', () => {
  it('renders a user message with the "you" label', () => {
    const history: CoreMessage[] = [{ role: 'user', content: 'hello bernard' }];
    const { lastFrame } = render(createElement(Thread, { history }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('you');
    expect(frame).toContain('hello bernard');
  });

  it('renders an assistant message with the "bernard" label', () => {
    const history: CoreMessage[] = [{ role: 'assistant', content: 'hi there' }];
    const { lastFrame } = render(createElement(Thread, { history }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('bernard');
    expect(frame).toContain('hi there');
  });

  it('renders structured assistant content (text + reasoning + tool-call)', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'plain output' },
          { type: 'reasoning', text: 'thinking…' },
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'shell',
            args: { cmd: 'ls' },
          },
        ] as unknown as CoreMessage['content'],
      },
    ];
    const { lastFrame } = render(createElement(Thread, { history }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('plain output');
    expect(frame).toContain('thinking…');
    expect(frame).toContain('⚙ shell');
    expect(frame).toContain('{"cmd":"ls"}');
  });

  it('renders a tool-result message and dims non-error results', () => {
    const history: CoreMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'shell',
            result: 'file1\nfile2\n',
          },
        ],
      },
    ];
    const { lastFrame } = render(createElement(Thread, { history }));
    expect(lastFrame()).toContain('↳');
    expect(lastFrame()).toContain('file1');
  });

  it('truncates oversized assistant tool-call args', () => {
    const longCmd = 'x'.repeat(500);
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'shell',
            args: { cmd: longCmd },
          },
        ] as unknown as CoreMessage['content'],
      },
    ];
    const { lastFrame } = render(createElement(Thread, { history }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⚙ shell');
    expect(frame).toContain('…');
    expect(frame).not.toContain(longCmd);
  });

  it('skips system messages silently', () => {
    const history: CoreMessage[] = [
      { role: 'system', content: 'YOU ARE BERNARD' },
      { role: 'user', content: 'hi' },
    ];
    const { lastFrame } = render(createElement(Thread, { history }));
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('YOU ARE BERNARD');
    expect(frame).toContain('hi');
  });

  it('renders streaming text-deltas under the "bernard" label when busy', () => {
    const store = new MessageStore();
    store.append({ kind: 'text-delta', text: 'hello' });
    store.append({ kind: 'text-delta', text: ' world' });
    const { lastFrame } = render(
      createElement(Thread, { history: [], messageStore: store, busy: true }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('bernard');
    expect(frame).toContain('hello world');
  });

  it('pairs a streaming tool-call with its result by callId', () => {
    const store = new MessageStore();
    store.append({ kind: 'tool-call', callId: 'c1', toolName: 'shell', args: { cmd: 'ls' } });
    store.append({ kind: 'tool-result', callId: 'c1', result: 'ok', isError: false });
    const { lastFrame } = render(
      createElement(Thread, { history: [], messageStore: store, busy: true }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⚙ shell');
    expect(frame).toContain('↳ ok');
  });

  it('renders a sub-agent label distinct from bernard', () => {
    const store = new MessageStore();
    store.append({ kind: 'text-delta', text: 'main says', agentLabel: undefined });
    store.append({ kind: 'text-delta', text: 'sub says', agentLabel: 'sub:1' });
    const { lastFrame } = render(
      createElement(Thread, { history: [], messageStore: store, busy: true }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('bernard');
    expect(frame).toContain('sub:1');
    expect(frame).toContain('main says');
    expect(frame).toContain('sub says');
  });

  it('does not mount StreamingAssistantMessage when not busy', () => {
    const store = new MessageStore();
    store.append({ kind: 'text-delta', text: 'should not render' });
    const { lastFrame } = render(
      createElement(Thread, { history: [], messageStore: store, busy: false }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('should not render');
  });
});
