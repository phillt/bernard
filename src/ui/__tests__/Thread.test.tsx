import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import stripAnsi from 'strip-ansi';
import type { CoreMessage } from 'ai';
import { Thread, type StaticItem } from '../Thread.js';
import { TranscriptViewport } from '../TranscriptViewport.js';
import { MessageStore } from '../message-store.js';
import { DimensionsProvider } from '../DimensionsContext.js';
import { Box, Text } from 'ink';
import { PAGE_UP, tick } from './_keys.js';

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

  it('renders the user-facing recovery hint under a failed tool result (#353)', () => {
    // The committed path recomputes the failure: streaming events are replaced
    // by static items at turn commit, so a hint that only lived on the stream
    // would vanish the moment the turn ended.
    const history: CoreMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'shell',
            result: { output: 'bash: nope: command not found', is_error: true },
          },
        ],
      },
    ];
    const frame = stripAnsi(
      render(createElement(Thread, { staticItems: items(history, true) })).lastFrame() ?? '',
    );
    // That it is the USER's playbook is pinned in `tool-failure.test.ts`;
    // here the question is only whether the line reaches the transcript.
    expect(frame).toContain('not_found');
  });

  it('adds no hint line to a successful tool result', () => {
    const history: CoreMessage[] = [
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'shell', result: { output: 'ok' } },
        ],
      },
    ];
    const frame = stripAnsi(
      render(createElement(Thread, { staticItems: items(history, true) })).lastFrame() ?? '',
    );
    expect(frame).not.toContain('·');
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

/**
 * The viewport's LAYOUT, which the suite above cannot reach (#435).
 *
 * Those three tests mount `<TranscriptViewport>` standalone — no fixed-height
 * parent and no sibling competing for rows — and that is precisely why this
 * bug had no coverage. With nothing to compete against there is no negative
 * free space, so the flex distribution that produced the defect never happens
 * and every offset looks correct.
 *
 * Here the viewport sits in a `height`-pinned frame beside a chrome sibling of
 * known height, which is the shape `App` renders in full-screen. `measureElement`
 * does work under ink-testing-library, but it converges through `useEffect`, so
 * assertions about the settled state need a `tick()` — and assertions about the
 * FIRST frame must read `frames[0]`, since the whole defect was that the wrong
 * frame is what the user sees.
 */
describe('<TranscriptViewport> layout inside a fixed-height frame', () => {
  const FRAME_ROWS = 24;
  const CHROME_ROWS = 8;

  /** One `<Text>` per row, so the sibling's height is exactly CHROME_ROWS. */
  const chrome = createElement(
    Box,
    { flexDirection: 'column' },
    ...Array.from({ length: CHROME_ROWS }, (_, i) => createElement(Text, { key: i }, `CHROME${i}`)),
  );

  /**
   * An assistant turn of `n` individually findable rows. A markdown list, so
   * every rendered row carries a marker: blank rows between paragraphs would
   * make "how many content rows are visible" a lossy count, and that count is
   * the whole point of the height-stability assertion below.
   */
  function tallReply(n: number): StaticItem[] {
    return items([
      {
        role: 'assistant',
        content: Array.from({ length: n }, (_, i) => `- REPLY-${i}`).join('\n'),
      },
    ]);
  }

  function mountFramed(props: Parameters<typeof TranscriptViewport>[0]) {
    return render(
      createElement(
        DimensionsProvider,
        null,
        createElement(
          Box,
          { flexDirection: 'column', height: FRAME_ROWS },
          createElement(TranscriptViewport, props),
          chrome,
        ),
      ),
    );
  }

  const chromeRowsIn = (frame: string) => (stripAnsi(frame).match(/^CHROME\d+$/gm) ?? []).length;
  const contentRows = (frame: string | undefined) =>
    (stripAnsi(frame ?? '').match(/REPLY-\d+/g) ?? []).length;

  it('leaves the chrome its full height on the very first frame', async () => {
    // The defect, stated directly. `overflow: hidden` is paint-only in Ink, so
    // without `flexBasis={0}` the viewport's flex base size is its whole
    // content — 60-odd rows — and the frame's negative free space is split with
    // the chrome, which rendered at 3 of its 8 rows before this was fixed. That
    // is a prompt box losing five rows to a transcript that mis-measured
    // itself, and it is what the reporter's screenshot showed.
    const { frames } = mountFramed({ items: tallReply(30) });
    expect(chromeRowsIn(frames[0])).toBe(CHROME_ROWS);
    await tick();
    expect(chromeRowsIn(frames[frames.length - 1])).toBe(CHROME_ROWS);
  });

  it('settles its window in a single measure pass', async () => {
    // The same defect seen as time rather than space: a content-dependent flex
    // basis makes `measureElement` return a height that depends on the current
    // offset, so the viewport walked its way to the answer over four passes
    // (viewportH 21 → 17 → 16 → 15). Streaming restarts that on every delta, so
    // it never settled while output was flowing. This is the guard against the
    // basis prop being tidied away as redundant.
    const { frames } = mountFramed({ items: tallReply(30) });
    await tick();
    const settled = stripAnsi(frames[frames.length - 1]);
    expect(stripAnsi(frames[1])).toBe(settled);
  });

  it('shows the tail at rest and says where in the transcript it is', async () => {
    const { lastFrame } = mountFramed({ items: tallReply(30) });
    await tick();
    const frame = stripAnsi(lastFrame() ?? '');
    // Stuck at the bottom: the newest content is on screen…
    expect(frame).toContain('REPLY-29');
    // …the oldest is not…
    expect(frame).not.toContain('REPLY-0\n');
    // …and, unlike before, the screen says so. A message opening mid-thought
    // with no marker is what made a complete answer read as a truncated one.
    // One fact in the house spelling (#470): the old string also carried
    // `▲ N more rows above`, which is `first - 1` and so the same number again.
    expect(frame).toMatch(/rows \d+–\d+ of \d+/);
  });

  // #470: it describes what is ABOVE, so it has to be read before the content,
  // not after it. Nothing pinned the ordering before this.
  it('renders the position row above the content it describes', async () => {
    const { lastFrame } = mountFramed({ items: tallReply(30) });
    await tick();
    const lines = stripAnsi(lastFrame() ?? '').split('\n');
    const positionRow = lines.findIndex((l) => /rows \d+–\d+ of \d+/.test(l));
    const firstContent = lines.findIndex((l) => /REPLY-\d+/.test(l));
    expect(positionRow).toBeGreaterThanOrEqual(0);
    expect(positionRow).toBeLessThan(firstContent);
  });

  it('reaches the first row of an over-tall reply with PgUp', async () => {
    // "Fully reachable" from the acceptance list, tested rather than asserted.
    const { stdin, lastFrame } = mountFramed({ items: tallReply(30) });
    await tick();
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('REPLY-0\n');
    // Bounded rather than a fixed count: the test deliberately does not compute
    // the page size, but 20 blind presses to do a 2-press job made this the
    // slowest test in the file by 4x. The bound keeps it honest if paging breaks.
    for (let i = 0; i < 30 && !stripAnsi(lastFrame() ?? '').includes('REPLY-0'); i++) {
      stdin.write(PAGE_UP);
      await tick(2);
    }
    expect(stripAnsi(lastFrame() ?? '')).toContain('REPLY-0');
  });

  it('shows the same number of content rows scrolled as at rest', async () => {
    // The position row is reserved unconditionally (`OverlayFooter`'s rule).
    // Rendering it only while scrolled made the viewport lose a content row at
    // the moment the user scrolled — the layout height depending on the very
    // budget that decides what is hidden.
    //
    // Counting CONTENT rows, not `frameRows`: the frame is pinned at
    // FRAME_ROWS, so its total never moves and would assert nothing. What the
    // conditional row actually cost was a row of transcript.
    const { stdin, lastFrame } = mountFramed({ items: tallReply(30) });
    await tick();
    const atRest = contentRows(lastFrame());
    expect(atRest).toBeGreaterThan(0);
    stdin.write(PAGE_UP);
    await tick(2);
    expect(contentRows(lastFrame())).toBe(atRest);
  });

  it('reserves the position row as a blank when everything fits', async () => {
    const { lastFrame } = mountFramed({ items: tallReply(2) });
    await tick();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('REPLY-0');
    // Matched against the CURRENT spelling, not a retired one — a negative
    // assertion on a string the component can no longer emit passes forever
    // and tests nothing.
    expect(frame).not.toMatch(/rows \d+–\d+ of \d+/);
  });
});

/**
 * The two transcript surfaces must render an item identically (#462).
 *
 * `<Thread>`'s `<Static>` list and `<TranscriptViewport>`'s windowed column
 * each carried their own copy of the `error / message` ladder, and which one a
 * user sees is decided by TTY detection at startup — so a variant added to one
 * and not the other is a bug that reproduces for half the users and is
 * invisible to whoever wrote it. `<StaticItemView>` is the single ladder; this
 * is what stops it silently becoming two again.
 */
describe('both transcript surfaces render the same item', () => {
  const ITEMS: StaticItem[] = [
    {
      key: 'a',
      message: { role: 'assistant', content: 'a plain answer' } as CoreMessage,
      toolDetails: false,
    },
    {
      key: 'b',
      error: { title: 'Turn failed', message: 'the provider refused' },
      toolDetails: false,
    },
  ];

  it('shows the same text for a message and for an error panel', () => {
    const inline = render(createElement(Thread, { staticItems: ITEMS, busy: false }));
    const full = render(
      createElement(TranscriptViewport, { items: ITEMS, busy: false, rows: 40 } as never),
    );
    const inlineText = stripAnsi(inline.lastFrame() ?? '');
    const fullText = stripAnsi(full.lastFrame() ?? '');

    for (const expected of ['a plain answer', 'Turn failed', 'the provider refused']) {
      expect(inlineText).toContain(expected);
      expect(fullText).toContain(expected);
    }
    inline.unmount();
    full.unmount();
  });
});
