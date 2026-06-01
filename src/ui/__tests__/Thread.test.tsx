import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import type { CoreMessage } from 'ai';
import { Thread } from '../Thread.js';
import { MessageStore } from '../message-store.js';

describe('<Thread>', () => {
  it('renders a user message with the right-side marker', () => {
    const history: CoreMessage[] = [{ role: 'user', content: 'hello bernard' }];
    const { lastFrame } = render(createElement(Thread, { history }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello bernard');
    expect(frame).toContain('❯');
  });

  it('renders an "interrupted" notice when the prop is set and not busy', () => {
    const history: CoreMessage[] = [{ role: 'user', content: 'hi' }];
    const { lastFrame } = render(createElement(Thread, { history, interrupted: true }));
    expect(lastFrame() ?? '').toContain('you interrupted');
  });

  it('renders an assistant message with the chevron label', () => {
    const history: CoreMessage[] = [{ role: 'assistant', content: 'hi there' }];
    const { lastFrame } = render(createElement(Thread, { history }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('❮');
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
    const { lastFrame } = render(createElement(Thread, { history, toolDetails: true }));
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
    const { lastFrame } = render(createElement(Thread, { history, toolDetails: true }));
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
    const { lastFrame } = render(createElement(Thread, { history, toolDetails: true }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⚙ shell');
    expect(frame).toContain('…');
    expect(frame).not.toContain(longCmd);
  });

  it('hides tool-call args and result bodies when toolDetails is off', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'shell',
            args: { cmd: 'ls' },
          },
        ] as unknown as CoreMessage['content'],
      },
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
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⚙ shell');
    expect(frame).not.toContain('{"cmd":"ls"}');
    expect(frame).not.toContain('↳');
    expect(frame).not.toContain('file1');
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

  it('renders streaming text-deltas under the chevron label when busy', () => {
    const store = new MessageStore();
    store.append({ kind: 'text-delta', text: 'hello' });
    store.append({ kind: 'text-delta', text: ' world' });
    const { lastFrame } = render(
      createElement(Thread, { history: [], messageStore: store, busy: true }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('❮');
    expect(frame).toContain('hello world');
  });

  it('pairs a streaming tool-call with its result by callId', () => {
    const store = new MessageStore();
    store.append({ kind: 'tool-call', callId: 'c1', toolName: 'shell', args: { cmd: 'ls' } });
    store.append({ kind: 'tool-result', callId: 'c1', result: 'ok', isError: false });
    const { lastFrame } = render(
      createElement(Thread, {
        history: [],
        messageStore: store,
        busy: true,
        toolDetails: true,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⚙ shell');
    expect(frame).toContain('↳ ok');
  });

  it('renders a sub-agent label distinct from the main chevron', () => {
    const store = new MessageStore();
    store.append({ kind: 'text-delta', text: 'main says', agentLabel: undefined });
    store.append({ kind: 'text-delta', text: 'sub says', agentLabel: 'sub:1' });
    const { lastFrame } = render(
      createElement(Thread, {
        history: [],
        messageStore: store,
        busy: true,
        toolDetails: true,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('❮');
    expect(frame).toContain('sub:1');
    expect(frame).toContain('main says');
    expect(frame).toContain('sub says');
  });

  it('hides streaming sub-agent / wrapper labels and bodies when toolDetails is off', () => {
    const store = new MessageStore();
    store.append({ kind: 'text-delta', text: 'main says', agentLabel: undefined });
    store.append({ kind: 'text-delta', text: 'wrapper-json-blob', agentLabel: 'wrap:3' });
    store.append({
      kind: 'tool-call',
      callId: 'c1',
      toolName: 'web_read',
      args: { url: 'https://example.com' },
      agentLabel: 'wrap:3',
    });
    store.append({
      kind: 'tool-result',
      callId: 'c1',
      result: '{"status":"ok"}',
      isError: false,
      agentLabel: 'wrap:3',
    });
    const { lastFrame } = render(
      createElement(Thread, { history: [], messageStore: store, busy: true }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('main says');
    expect(frame).not.toContain('wrap:3');
    expect(frame).not.toContain('wrapper-json-blob');
    expect(frame).not.toContain('web_read');
    expect(frame).not.toContain('status');
  });

  it('hides streaming main-agent tool-call args and result snippets when toolDetails is off', () => {
    const store = new MessageStore();
    store.append({
      kind: 'tool-call',
      callId: 'c1',
      toolName: 'shell',
      args: { cmd: 'ls -la' },
    });
    store.append({
      kind: 'tool-result',
      callId: 'c1',
      result: 'file1\nfile2',
      isError: false,
    });
    const { lastFrame } = render(
      createElement(Thread, { history: [], messageStore: store, busy: true }),
    );
    const frame = lastFrame() ?? '';
    // Tool name still surfaces (helps the user see "what is bernard doing").
    expect(frame).toContain('⚙ shell');
    // …but no args, no result snippet, no `↳` rail.
    expect(frame).not.toContain('ls -la');
    expect(frame).not.toContain('file1');
    expect(frame).not.toContain('↳');
  });

  it('hides streaming orphan tool-results when toolDetails is off', () => {
    // A tool-result with no matching tool-call (defensive path in StreamGroupBody).
    const store = new MessageStore();
    store.append({ kind: 'text-delta', text: 'hi' });
    store.append({
      kind: 'tool-result',
      callId: 'orphan-1',
      result: 'leaked-result-body',
      isError: false,
    });
    const { lastFrame } = render(
      createElement(Thread, { history: [], messageStore: store, busy: true }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hi');
    expect(frame).not.toContain('leaked-result-body');
    expect(frame).not.toContain('↳');
  });

  it('still renders streaming main-agent text when toolDetails is off', () => {
    // Guard against an over-eager suppression breaking the primary stream.
    const store = new MessageStore();
    store.append({ kind: 'text-delta', text: 'streaming answer' });
    const { lastFrame } = render(
      createElement(Thread, { history: [], messageStore: store, busy: true }),
    );
    expect(lastFrame() ?? '').toContain('streaming answer');
  });

  it('hides static tool messages and tool-call args across multiple turns when toolDetails is off', () => {
    // Static-view counterpart: confirms what the user sees after the turn ends.
    const history: CoreMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'working' },
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'web_read',
            args: { url: 'https://aaro.mil/' },
          },
        ] as unknown as CoreMessage['content'],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'web_read',
            result: { status: 'ok', result: { content_excerpt: 'AARO Home' } },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }] as unknown as CoreMessage['content'],
      },
    ];
    const { lastFrame } = render(createElement(Thread, { history }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⚙ web_read');
    expect(frame).not.toContain('aaro.mil');
    expect(frame).not.toContain('AARO Home');
    expect(frame).not.toContain('↳');
    expect(frame).not.toContain('"status"');
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
