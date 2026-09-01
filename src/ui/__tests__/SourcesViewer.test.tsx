import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { ENTER, ESC, ARROW_DOWN, ARROW_LEFT, ARROW_RIGHT, SHIFT_TAB, tick } from './_keys.js';
import { SourcesViewer } from '../overlays/SourcesViewer.js';
import { DimensionsProvider } from '../DimensionsContext.js';
import type { Agent } from '../../agent.js';
import type { TurnProvenance } from '../../provenance.js';
import { formatFriendlyTimestamp } from '../../output.js';

function makeAgent(turns: TurnProvenance[]): Agent {
  return { getTurnProvenance: () => turns } as unknown as Agent;
}

/**
 * Render `<SourcesViewer>` inside `<DimensionsProvider>` (as in production) so
 * it reads the test stdout's real width/height through the dimensions context
 * rather than the 80×24 fallback used when no provider is mounted.
 */
function renderViewer(agent: Agent) {
  return render(createElement(DimensionsProvider, null, createElement(SourcesViewer, { agent })));
}

// A multi-line excerpt longer than a single wrapped line, to exercise the
// right-panel content render. Well under the 2000-char store cap.
// Long, multi-line excerpt: a recognizable first line plus a run long enough to
// overflow the right-panel card at any reasonable terminal height (forces clip).
const PREVIEW =
  'The Rust programming language emphasizes memory safety.\n' + 'guarantee '.repeat(200);

const REGRESSION_TURNS: TurnProvenance[] = [
  {
    turnIndex: 0,
    userInput: 'tell me about Rust',
    sources: [
      {
        id: 'S1',
        kind: 'web',
        label: 'rust-lang.org',
        contentPreview: PREVIEW,
        rawRef: 'https://www.rust-lang.org/',
        timestamp: 0,
      },
      {
        id: 'S2',
        kind: 'rag',
        label: 'rust-fact-1',
        contentPreview: 'short snippet',
        rawRef: 'rag://rust-fact-1',
        timestamp: 0,
      },
    ],
    citedIds: ['S1'],
    timestamp: 0,
  },
  {
    turnIndex: 1,
    userInput: 'follow-up question that has no citations in the final message',
    sources: [
      {
        id: 'S1',
        kind: 'tool-result',
        label: 'shell:cargo --version',
        contentPreview: 'cargo 1.78.0',
        rawRef: 'shell:cargo',
        timestamp: 0,
      },
    ],
    citedIds: [],
    timestamp: 0,
  },
];

describe('<SourcesViewer> two-panel browser', () => {
  it('renders empty state when no turns have provenance', () => {
    const { lastFrame } = renderViewer(makeAgent([]));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No citations recorded yet.');
    expect(frame).toContain('esc close');
  });

  it('lists every turn with its source count (no citation rows yet)', () => {
    const { lastFrame } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS) }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Turn 1 · tell me about Rust');
    expect(frame).toContain('Turn 2 · follow-up question');
    expect(frame).toContain('(2 sources)');
    expect(frame).toContain('(1 source)');
    // Turn list level — no per-citation rows are shown.
    expect(frame).not.toContain('[^S1]');
    expect(frame).not.toContain('rust-lang.org');
  });

  it('drills into a turn on Enter, showing the split panel of citations + content', async () => {
    const { stdin, lastFrame } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS) }),
    );
    await tick();
    stdin.write('g'); // recent-first (#248): walk back to turn 1, this fixture's rich turn.
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    // Left list shows both citations for the turn.
    expect(frame).toContain('[^S1]');
    expect(frame).toContain('[^S2]');
    expect(frame).toContain('rust-lang.org');
    // Right panel shows the highlighted (first) citation's content + status.
    expect(frame).toContain('cited');
    expect(frame).toContain('https://www.rust-lang.org/');
    expect(frame).toContain('The Rust programming language');
    // Back hint replaces the close hint while drilled in.
    expect(frame).toContain('esc/← back');
  });

  it('updates the right content panel as the citation highlight moves', async () => {
    const { stdin, lastFrame } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS) }),
    );
    await tick();
    stdin.write('g'); // recent-first (#248): walk back to turn 1, this fixture's rich turn.
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(ARROW_DOWN); // highlight S2
    await tick();
    const frame = lastFrame() ?? '';
    // S2 content + ref now in the panel; it is uncited.
    expect(frame).toContain('rust-fact-1');
    expect(frame).toContain('short snippet');
    expect(frame).toContain('not cited');
  });

  it('Esc from the split panel returns to the turn list (does NOT close the viewer)', async () => {
    const onClose = vi.fn();
    const { stdin, lastFrame } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS), onClose }),
    );
    await tick();
    stdin.write(ENTER); // drill in
    await tick();
    stdin.write(ESC); // back to list
    await tick();
    const frame = lastFrame() ?? '';
    expect(onClose).not.toHaveBeenCalled();
    expect(frame).toContain('Turn 1 · tell me about Rust');
    expect(frame).toContain('esc close');
    // Left-arrow also steps back: re-drill then ←.
    stdin.write(ENTER);
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    expect(onClose).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('Turn 2 · follow-up question');
  });

  it('Esc at the turn list closes the viewer via the shell', async () => {
    const onClose = vi.fn();
    const { stdin } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS), onClose }),
    );
    await tick();
    stdin.write(ESC);
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Shift+Tab cycles tabs at both the turn list and the split panel', async () => {
    const onCycleTab = vi.fn();
    const { stdin } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS), onCycleTab }),
    );
    await tick();
    stdin.write(SHIFT_TAB); // at turn list
    await tick();
    expect(onCycleTab).toHaveBeenCalledTimes(1);
    stdin.write(ENTER); // drill in
    await tick();
    stdin.write(SHIFT_TAB); // in split panel
    await tick();
    expect(onCycleTab).toHaveBeenCalledTimes(2);
  });

  it('windows a long content preview and scrolls the right panel on demand', async () => {
    const { stdin, lastFrame } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS) }),
    );
    await tick();
    stdin.write('g'); // recent-first (#248): walk back to turn 1, this fixture's rich turn.
    await tick();
    stdin.write(ENTER);
    await tick();
    // The long "guarantee" run wraps past the card height → a windowed excerpt
    // with a position indicator starting at line 1, and a hint to scroll.
    expect(lastFrame() ?? '').toMatch(/lines 1–\d+ of \d+/);
    expect(lastFrame() ?? '').toContain('→ read');
    // Focus the content panel and scroll down — the window advances.
    stdin.write(ARROW_RIGHT);
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    expect(lastFrame() ?? '').toMatch(/lines 2–/);
    // Esc steps back to the citation list (not out of the viewer).
    stdin.write(ESC);
    await tick();
    expect(lastFrame() ?? '').toContain('[^S1]');
    expect(lastFrame() ?? '').toMatch(/lines 1–/);
  });

  it('wraps a long title onto new lines instead of cutting it off', async () => {
    const longLabel =
      'MyChart browser automation workflow if not authenticated automation cannot proceed';
    const turns: TurnProvenance[] = [
      {
        turnIndex: 0,
        userInput: 'long title turn',
        sources: [
          {
            id: 'S1',
            kind: 'rag',
            label: longLabel,
            contentPreview: 'body',
            rawRef: 'rag://x',
            timestamp: 0,
          },
        ],
        citedIds: [],
        timestamp: 0,
      },
    ];
    const { stdin, lastFrame } = renderViewer(makeAgent(turns));
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    // The tail of the title that an ellipsis-truncate would have dropped is
    // still present (it wrapped onto a later line).
    expect(frame).toContain('automation cannot proceed');
  });

  it('renders JSON tool-result content as an aligned key/value table', async () => {
    const turns: TurnProvenance[] = [
      {
        turnIndex: 0,
        userInput: 'json turn',
        sources: [
          {
            id: 'S1',
            kind: 'tool-result',
            label: 'plan',
            contentPreview: 'plan: {"action":"update","id":"step-1","done":true}',
            rawRef: 'tool:plan',
            timestamp: 0,
          },
        ],
        citedIds: [],
        timestamp: 0,
      },
    ];
    const { stdin, lastFrame } = renderViewer(makeAgent(turns));
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    // Keys and values are laid out as a table — no raw braces/quotes.
    expect(frame).toContain('action');
    expect(frame).toContain('update');
    expect(frame).toContain('step-1');
    expect(frame).not.toContain('{"action"');
  });

  it('pretty-prints nested JSON tool-result content with indentation', async () => {
    const turns: TurnProvenance[] = [
      {
        turnIndex: 0,
        userInput: 'nested json turn',
        sources: [
          {
            id: 'S1',
            kind: 'tool-result',
            label: 'plan',
            contentPreview: 'plan: {"action":"create","steps":["a","b"]}',
            rawRef: 'tool:plan',
            timestamp: 0,
          },
        ],
        citedIds: [],
        timestamp: 0,
      },
    ];
    const { stdin, lastFrame } = renderViewer(makeAgent(turns));
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    // Nested value → indented JSON (not the flat key/value table).
    expect(frame).toContain('"action": "create"');
    expect(frame).toContain('"steps"');
  });

  it('falls back to raw text when the JSON preview was truncated mid-object', async () => {
    const turns: TurnProvenance[] = [
      {
        turnIndex: 0,
        userInput: 'truncated json turn',
        sources: [
          {
            id: 'S1',
            kind: 'tool-result',
            label: 'plan',
            // Trailing ellipsis from the store cap → unparseable.
            contentPreview: 'plan: {"action":"update","id":"step-1"…',
            rawRef: 'tool:plan',
            timestamp: 0,
          },
        ],
        citedIds: [],
        timestamp: 0,
      },
    ];
    const { stdin, lastFrame } = renderViewer(makeAgent(turns));
    await tick();
    stdin.write(ENTER);
    await tick();
    // Unparseable → shown verbatim (with the raw braces), not as a table.
    expect(lastFrame() ?? '').toContain('{"action"');
  });

  it('does not enter content focus when the excerpt already fits', async () => {
    const turns: TurnProvenance[] = [
      {
        turnIndex: 0,
        userInput: 'short content turn',
        sources: [
          {
            id: 'S1',
            kind: 'web',
            label: 'tiny',
            contentPreview: 'one short line',
            rawRef: 'https://a',
            timestamp: 0,
          },
        ],
        citedIds: [],
        timestamp: 0,
      },
    ];
    const { stdin, lastFrame } = renderViewer(makeAgent(turns));
    await tick();
    stdin.write(ENTER);
    await tick();
    // No overflow → list-focus hint, no scroll affordance.
    expect(lastFrame() ?? '').not.toContain('→ read');
    expect(lastFrame() ?? '').not.toMatch(/lines \d+–\d+ of/);
    // → is a no-op (stays in list focus): the back hint remains the list one.
    stdin.write(ARROW_RIGHT);
    await tick();
    expect(lastFrame() ?? '').toContain('esc/← back');
    expect(lastFrame() ?? '').not.toContain('back to list');
  });

  it('orders citations cited-first regardless of registration order', async () => {
    const turns: TurnProvenance[] = [
      {
        turnIndex: 0,
        userInput: 'mixed citation order',
        sources: [
          {
            id: 'S1',
            kind: 'web',
            label: 'uncited-first',
            contentPreview: 'alpha',
            rawRef: 'https://a',
            timestamp: 0,
          },
          {
            id: 'S2',
            kind: 'web',
            label: 'the-cited-one',
            contentPreview: 'bravo',
            rawRef: 'https://b',
            timestamp: 0,
          },
        ],
        citedIds: ['S2'],
        timestamp: 0,
      },
    ];
    const { stdin, lastFrame } = renderViewer(makeAgent(turns));
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    // The cited source sorts to the top, so it is the initial highlight and
    // the right panel shows its content + cited status (not the uncited S1).
    expect(frame).toContain('the-cited-one');
    expect(frame).toContain('bravo');
    expect(frame).toContain('· cited');
    expect(frame).not.toContain('not cited');
  });

  it('opens on the newest turn, with the window scrolled to show it (#248)', async () => {
    const turns: TurnProvenance[] = Array.from({ length: 30 }, (_, i) => ({
      turnIndex: i,
      userInput: `req-${i}`,
      sources: [
        { id: 'S1', kind: 'web', label: `src-${i}`, contentPreview: '', rawRef: 'r', timestamp: 0 },
      ],
      citedIds: ['S1'],
      timestamp: 0,
    }));
    const { stdin, lastFrame } = renderViewer(makeAgent(turns));
    let frame = lastFrame() ?? '';
    // Turn 30 is both rendered (the window scrolled to it) and highlighted (the
    // cursor is on it) — an unscrolled window would satisfy neither.
    expect(frame).toContain('Turn 30 ·');
    expect(frame).toMatch(/> Turn 30 ·/);
    expect(frame).not.toContain('Turn 1 ·');
    // ...and `g` still walks back to the oldest turn.
    await tick();
    stdin.write('g');
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).toContain('Turn 1 ·');
    expect(frame).not.toContain('Turn 30 ·');
  });

  it('drills into the newest turn on a single Enter (#248)', async () => {
    const { stdin, lastFrame } = renderViewer(makeAgent(REGRESSION_TURNS));
    await tick();
    stdin.write(ENTER);
    await tick();
    // Turn 2's only source — reached with one keystroke, no `G` first.
    expect(lastFrame() ?? '').toContain('shell:cargo --version');
  });
});

/** One turn holding a single tool-result citation with `preview` as its body. */
function toolResultTurn(preview: string): TurnProvenance[] {
  return [
    {
      turnIndex: 0,
      userInput: 'list turn',
      sources: [
        {
          id: 'S1',
          kind: 'tool-result',
          label: 'issues',
          contentPreview: preview,
          rawRef: 'tool:issues',
          timestamp: 0,
        },
      ],
      citedIds: [],
      timestamp: 0,
    },
  ];
}

describe('<SourcesViewer> array-of-objects tool results (#248)', () => {
  async function drill(preview: string): Promise<string> {
    const { stdin, lastFrame } = renderViewer(makeAgent(toolResultTurn(preview)));
    await tick();
    stdin.write(ENTER);
    await tick();
    return lastFrame() ?? '';
  }

  it('renders an array of flat objects as a column table', async () => {
    const frame = await drill(
      'issues: [{"id":"1","title":"Fix the parser","state":"open"},' +
        '{"id":"2","title":"Ship the viewer","state":"closed"}]',
    );
    // Header row names the auto-selected columns...
    expect(frame).toContain('title');
    expect(frame).toContain('state');
    // ...and each element is one row, not a pretty-printed object.
    expect(frame).toContain('Fix the parser');
    expect(frame).toContain('Ship the viewer');
    expect(frame).not.toContain('{"id"');
    expect(frame).not.toContain('"title":');
  });

  it('falls back to pretty-printed JSON for a ragged array', async () => {
    const frame = await drill('issues: [{"a":1},{"b":2},{"c":3}]');
    expect(frame).toContain('"a": 1');
  });

  it('falls back to pretty-printed JSON for an array of nested objects', async () => {
    const frame = await drill('issues: [{"meta":{"x":1}},{"meta":{"y":2}}]');
    expect(frame).toContain('"meta"');
    expect(frame).toContain('"x": 1');
  });

  it('falls back to pretty-printed JSON for an array of scalars', async () => {
    const frame = await drill('issues: ["alpha","beta"]');
    expect(frame).toContain('"alpha"');
  });
});

describe('<SourcesViewer> citation timestamp (#248)', () => {
  function timedTurn(timestamp: number): TurnProvenance[] {
    return [
      {
        turnIndex: 0,
        userInput: 'timed turn',
        sources: [
          {
            id: 'S1',
            kind: 'web',
            label: 'example.com',
            contentPreview: 'body',
            rawRef: 'https://example.com',
            timestamp,
          },
        ],
        citedIds: ['S1'],
        timestamp,
      },
    ];
  }

  async function drill(turns: TurnProvenance[]): Promise<string> {
    const { stdin, lastFrame } = renderViewer(makeAgent(turns));
    await tick();
    stdin.write(ENTER);
    await tick();
    return lastFrame() ?? '';
  }

  it('shows when the source was registered, and how long ago', async () => {
    const fiveMinutesAgo = Date.now() - 5 * 60_000;
    const frame = await drill(timedTurn(fiveMinutesAgo));
    expect(frame).toContain(formatFriendlyTimestamp(new Date(fiveMinutesAgo)));
    expect(frame).toContain('(5m0s ago)');
    // It rides the existing kind/cited row rather than claiming one of its own.
    expect(frame).toMatch(/web · cited · .+ago\)/);
  });

  it('renders nothing at all for a record with no usable stamp', async () => {
    const frame = await drill(timedTurn(0));
    expect(frame).toContain('web · cited');
    expect(frame).not.toContain('ago)');
    expect(frame).not.toContain('1970');
  });
});
