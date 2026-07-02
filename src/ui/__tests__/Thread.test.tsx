import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import stripAnsi from 'strip-ansi';
import type { CoreMessage } from 'ai';
import { Thread, type StaticItem } from '../Thread.js';
import { TranscriptViewport } from '../TranscriptViewport.js';
import { MessageStore } from '../message-store.js';
import { DimensionsProvider } from '../DimensionsContext.js';

/**
 * Build the append-only `staticItems` log <Thread> now renders through
 * <Static> (#232). Each finalized message snapshots its own `toolDetails`;
 * `extras` lets a test attach a timing footer or rewrite original to a
 * specific index.
 */
function items(
  history: CoreMessage[],
  toolDetails = false,
  extras?: Record<number, Partial<StaticItem>>,
): StaticItem[] {
  return history.map((message, i) => ({
    key: String(i),
    message,
    toolDetails,
    ...(extras?.[i] ?? {}),
  }));
}

describe('<Thread>', () => {
  it('renders a user message with the right-side marker', () => {
    const history: CoreMessage[] = [{ role: 'user', content: 'hello bernard' }];
    const { lastFrame } = render(createElement(Thread, { staticItems: items(history) }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello bernard');
    expect(frame).toContain('❯');
  });

  it('renders an "interrupted" notice when the prop is set and not busy', () => {
    const history: CoreMessage[] = [{ role: 'user', content: 'hi' }];
    const { lastFrame } = render(
      createElement(Thread, { staticItems: items(history), interrupted: true }),
    );
    expect(lastFrame() ?? '').toContain('you interrupted');
  });

  it('renders an error StaticItem as an ErrorPanel instead of a message', () => {
    const staticItems: StaticItem[] = [
      {
        key: 'e0',
        toolDetails: false,
        error: {
          title: 'Rate limit / quota',
          category: 'rate_limit',
          message: 'You exceeded your current quota.',
          hint: 'wait or switch lineup',
        },
      },
    ];
    const frame = stripAnsi(render(createElement(Thread, { staticItems })).lastFrame() ?? '');
    expect(frame).toContain('⚠ Rate limit / quota');
    expect(frame).toContain('You exceeded your current quota.');
    expect(frame).toMatch(/[╭╮╰╯]/);
  });

  it('renders an assistant message with the chevron label', () => {
    const history: CoreMessage[] = [{ role: 'assistant', content: 'hi there' }];
    const { lastFrame } = render(createElement(Thread, { staticItems: items(history) }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('❮');
    expect(frame).toContain('hi there');
  });

  it('renders the per-item timing footer under an assistant message', () => {
    const history: CoreMessage[] = [{ role: 'assistant', content: 'done' }];
    const { lastFrame } = render(
      createElement(Thread, {
        staticItems: items(history, false, {
          0: { timing: { endedAt: new Date('2026-01-01T12:00:00Z').getTime(), durationMs: 1200 } },
        }),
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('done');
    // 1200ms → "1.2s" per formatDuration.
    expect(frame).toContain('1.2s');
  });

  it('appends the per-turn cost label to the timing footer (#258)', () => {
    const history: CoreMessage[] = [{ role: 'assistant', content: 'done' }];
    const { lastFrame } = render(
      createElement(Thread, {
        staticItems: items(history, false, {
          0: {
            timing: { endedAt: new Date('2026-01-01T12:00:00Z').getTime(), durationMs: 1200 },
            costUsd: 0.0123,
          },
        }),
      }),
    );
    const frame = stripAnsi(lastFrame() ?? '');
    // formatUsd(0.0123) → "$0.012" (>= 0.01 → 3 decimals), prefixed with " · ~".
    expect(frame).toContain('~$0.012');
  });

  it('omits the cost label when costUsd is undefined', () => {
    const history: CoreMessage[] = [{ role: 'assistant', content: 'done' }];
    const { lastFrame } = render(
      createElement(Thread, {
        staticItems: items(history, false, {
          0: { timing: { endedAt: new Date('2026-01-01T12:00:00Z').getTime(), durationMs: 1200 } },
        }),
      }),
    );
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('~$');
  });

  it('shows the rewrite original (not the dispatched text) with the rewrite icon', () => {
    const history: CoreMessage[] = [{ role: 'user', content: 'REWRITTEN dispatched text' }];
    const { lastFrame } = render(
      createElement(Thread, {
        staticItems: items(history, false, { 0: { rewriteOriginal: 'original ask' } }),
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('original ask');
    expect(frame).not.toContain('REWRITTEN dispatched text');
    expect(frame).toContain('✎');
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
    const { lastFrame } = render(createElement(Thread, { staticItems: items(history, true) }));
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
    const { lastFrame } = render(createElement(Thread, { staticItems: items(history, true) }));
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
    const { lastFrame } = render(createElement(Thread, { staticItems: items(history, true) }));
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
    const { lastFrame } = render(createElement(Thread, { staticItems: items(history) }));
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
    const { lastFrame } = render(createElement(Thread, { staticItems: items(history) }));
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('YOU ARE BERNARD');
    expect(frame).toContain('hi');
  });

  it('renders streaming text-deltas under the chevron label when busy', () => {
    const store = new MessageStore();
    store.append({ kind: 'text-delta', text: 'hello' });
    store.append({ kind: 'text-delta', text: ' world' });
    const { lastFrame } = render(
      createElement(Thread, { staticItems: [], messageStore: store, busy: true }),
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
        staticItems: [],
        messageStore: store,
        busy: true,
        streamingToolDetails: true,
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
        staticItems: [],
        messageStore: store,
        busy: true,
        streamingToolDetails: true,
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
      createElement(Thread, { staticItems: [], messageStore: store, busy: true }),
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
      createElement(Thread, { staticItems: [], messageStore: store, busy: true }),
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
      createElement(Thread, { staticItems: [], messageStore: store, busy: true }),
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
      createElement(Thread, { staticItems: [], messageStore: store, busy: true }),
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
    const { lastFrame } = render(createElement(Thread, { staticItems: items(history) }));
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
      createElement(Thread, { staticItems: [], messageStore: store, busy: false }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('should not render');
  });

  it('echoes the plan step list for a static plan create call when toolDetails is on', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'p1',
            toolName: 'plan',
            args: {
              action: 'create',
              steps: [
                { description: 'Run the tests', verification: 'tests pass' },
                { description: 'Deploy the service', verification: 'service up' },
              ],
            },
          },
        ] as unknown as CoreMessage['content'],
      },
    ];
    const { lastFrame } = render(createElement(Thread, { staticItems: items(history, true) }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⚙ plan');
    expect(frame).toContain('1. Run the tests');
    expect(frame).toContain('2. Deploy the service');
  });

  it('echoes a plan update transition when toolDetails is on', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'p2',
            toolName: 'plan',
            args: { action: 'update', id: 1, status: 'done', signoff: 'verified by run' },
          },
        ] as unknown as CoreMessage['content'],
      },
    ];
    const { lastFrame } = render(createElement(Thread, { staticItems: items(history, true) }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('step 1 → done · verified by run');
  });

  it('renders only the plan tool name when toolDetails is off', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'p3',
            toolName: 'plan',
            args: {
              action: 'create',
              steps: [{ description: 'hidden step', verification: 'v' }],
            },
          },
        ] as unknown as CoreMessage['content'],
      },
    ];
    const { lastFrame } = render(createElement(Thread, { staticItems: items(history) }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⚙ plan');
    expect(frame).not.toContain('hidden step');
  });

  it('renders assistant markdown formatted (no literal ** delimiters)', () => {
    const history: CoreMessage[] = [{ role: 'assistant', content: 'some **bold text** here' }];
    const { lastFrame } = render(createElement(Thread, { staticItems: items(history) }));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('❮'); // chevron regression guard
    expect(frame).toContain('bold text');
    expect(frame).not.toContain('**');
  });

  it('renders assistant headings without the # prefix', () => {
    const history: CoreMessage[] = [{ role: 'assistant', content: '# Big Title\n\nbody text' }];
    const { lastFrame } = render(createElement(Thread, { staticItems: items(history) }));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Big Title');
    expect(frame).not.toContain('# Big Title');
    expect(frame).toContain('body text');
  });

  it('renders streaming markdown formatted with healed partial syntax', () => {
    const store = new MessageStore();
    store.append({ kind: 'text-delta', text: 'streamed **bo' });
    store.append({ kind: 'text-delta', text: 'ld**' });
    const { lastFrame } = render(
      createElement(Thread, { staticItems: [], messageStore: store, busy: true }),
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('❮');
    expect(frame).toContain('streamed bold');
    expect(frame).not.toContain('**');
  });

  it('leaves reasoning text raw (no markdown treatment)', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'raw **scratchpad** text' },
          { type: 'text', text: 'answer' },
        ] as unknown as CoreMessage['content'],
      },
    ];
    const { lastFrame } = render(createElement(Thread, { staticItems: items(history) }));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('**scratchpad**');
    expect(frame).toContain('answer');
  });

  it('echoes the plan step list on a streaming plan create when toolDetails is on', () => {
    const store = new MessageStore();
    store.append({
      kind: 'tool-call',
      callId: 'p4',
      toolName: 'plan',
      args: {
        action: 'create',
        steps: [{ description: 'streamed step', verification: 'v' }],
      },
    });
    store.append({
      kind: 'tool-result',
      callId: 'p4',
      result: 'Plan created with 1 steps.',
      isError: false,
    });
    const { lastFrame } = render(
      createElement(Thread, {
        staticItems: [],
        messageStore: store,
        busy: true,
        streamingToolDetails: true,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⚙ plan');
    expect(frame).toContain('1. streamed step');
    expect(frame).toContain('↳ Plan created with 1 steps.');
  });

  it('gives each streaming tool-call its own chevron block (no reflow at turn end)', () => {
    // Two sequential tool-calls must each render their own `❮` gutter, matching
    // the committed view where each agent step is a separate AssistantMessage.
    const store = new MessageStore();
    store.append({ kind: 'tool-call', callId: 'c1', toolName: 'web_search', args: {} });
    store.append({ kind: 'tool-call', callId: 'c2', toolName: 'web_read', args: {} });
    const { lastFrame } = render(
      createElement(Thread, { staticItems: [], messageStore: store, busy: true }),
    );
    const frame = lastFrame() ?? '';
    expect((frame.match(/❮/g) ?? []).length).toBe(2);
    expect(frame).toContain('⚙ web_search');
    expect(frame).toContain('⚙ web_read');
  });

  it('renders streaming text and a following tool-call as two chevron blocks', () => {
    const store = new MessageStore();
    store.append({ kind: 'text-delta', text: 'intro line' });
    store.append({ kind: 'tool-call', callId: 'c1', toolName: 'shell', args: { cmd: 'ls' } });
    const { lastFrame } = render(
      createElement(Thread, { staticItems: [], messageStore: store, busy: true }),
    );
    const frame = lastFrame() ?? '';
    expect((frame.match(/❮/g) ?? []).length).toBe(2);
    expect(frame).toContain('intro line');
    expect(frame).toContain('⚙ shell');
  });

  it('falls back to a lone chevron when a streaming think has an empty thought', () => {
    const store = new MessageStore();
    store.append({ kind: 'tool-call', callId: 't1', toolName: 'think', args: { thought: '' } });
    const { lastFrame } = render(
      createElement(Thread, { staticItems: [], messageStore: store, busy: true }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('❮');
    expect(frame).not.toContain('💭');
  });
});

describe('<TranscriptViewport> (full-screen transcript)', () => {
  // Wrap in the dimensions provider as production does so the viewport reads the
  // real terminal size (not the 80×24 no-provider fallback).
  function renderViewport(props: Parameters<typeof TranscriptViewport>[0]) {
    return render(
      createElement(DimensionsProvider, null, createElement(TranscriptViewport, props)),
    );
  }

  it('renders finalized turns through the scrollable viewport', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'hello bernard' },
      { role: 'assistant', content: 'hi there' },
    ];
    const frame = renderViewport({ items: items(history) }).lastFrame() ?? '';
    expect(frame).toContain('hello bernard');
    expect(frame).toContain('hi there');
    expect(frame).toContain('❯');
    expect(frame).toContain('❮');
  });

  it('renders the in-flight streaming turn at the bottom of the viewport', () => {
    const store = new MessageStore();
    store.append({ kind: 'text-delta', text: 'streaming reply' });
    const frame = renderViewport({ items: [], messageStore: store, busy: true }).lastFrame() ?? '';
    expect(frame).toContain('streaming reply');
  });

  it('renders an error StaticItem as an ErrorPanel in full-screen too', () => {
    const errorItems: StaticItem[] = [
      {
        key: 'e0',
        toolDetails: false,
        error: {
          title: 'Rate limit / quota',
          category: 'rate_limit',
          message: 'You exceeded your current quota.',
          hint: 'wait or switch lineup',
        },
      },
    ];
    const frame = stripAnsi(renderViewport({ items: errorItems }).lastFrame() ?? '');
    expect(frame).toContain('Rate limit / quota');
    expect(frame).toContain('You exceeded your current quota.');
  });
});
