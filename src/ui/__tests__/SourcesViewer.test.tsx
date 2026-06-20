import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { ENTER, ESC, ARROW_DOWN, ARROW_LEFT, SHIFT_TAB, tick } from './_keys.js';
import { SourcesViewer } from '../overlays/SourcesViewer.js';
import type { Agent } from '../../agent.js';
import type { TurnProvenance } from '../../provenance.js';

function makeAgent(turns: TurnProvenance[]): Agent {
  return { getTurnProvenance: () => turns } as unknown as Agent;
}

// A multi-line excerpt longer than a single wrapped line, to exercise the
// right-panel content render. Well under the 2000-char store cap.
// Long, multi-line excerpt: a recognizable first line plus a run long enough to
// overflow the right-panel card at any reasonable terminal height (forces clip).
const PREVIEW = 'The Rust programming language emphasizes memory safety.\n' + 'guarantee '.repeat(200);

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
    const { lastFrame } = render(createElement(SourcesViewer, { agent: makeAgent([]) }));
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

  it('clips a long content preview and reports how many lines are hidden', async () => {
    const { stdin, lastFrame } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS) }),
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    // The 400+ char "guarantee" run wraps to many lines; the card clips them.
    expect(lastFrame() ?? '').toMatch(/… \(\d+ more line/);
  });

  it('windows a long turn history and scrolls to reveal later turns', async () => {
    const turns: TurnProvenance[] = Array.from({ length: 30 }, (_, i) => ({
      turnIndex: i,
      userInput: `req-${i}`,
      sources: [{ id: 'S1', kind: 'web', label: `src-${i}`, contentPreview: '', rawRef: 'r', timestamp: 0 }],
      citedIds: ['S1'],
      timestamp: 0,
    }));
    const { stdin, lastFrame } = render(createElement(SourcesViewer, { agent: makeAgent(turns) }));
    let frame = lastFrame() ?? '';
    expect(frame).toContain('Turn 1 ·');
    expect(frame).not.toContain('Turn 30 ·');
    await tick();
    stdin.write('G'); // jump to last turn
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).toContain('Turn 30 ·');
  });
});
