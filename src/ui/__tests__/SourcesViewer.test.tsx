import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { ENTER, ARROW_DOWN, tick } from './_keys.js';
import { SourcesViewer } from '../overlays/SourcesViewer.js';
import type { Agent } from '../../agent.js';
import type { TurnProvenance } from '../../provenance.js';

function makeAgent(turns: TurnProvenance[]): Agent {
  return { getTurnProvenance: () => turns } as unknown as Agent;
}

const PREVIEW = 'a'.repeat(300); // exercises preview truncation in an expanded source

const REGRESSION_TURNS: TurnProvenance[] = [
  // Issue #211 round-1 case: citations only on intermediate steps; final
  // message cited none. The viewer still has to render the sources from
  // the prior turns with the right accent/dim treatment.
  {
    turnIndex: 0,
    userInput: 'tell me about Rust',
    sources: [
      {
        id: 'S1',
        kind: 'web',
        label: 'rust-lang.org',
        contentPreview: PREVIEW,
        rawRef: 'https://www.rust-lang.org/' + 'x'.repeat(200),
        timestamp: 0,
      },
      {
        id: 'S2',
        kind: 'rag',
        label: 'rust-fact-1',
        contentPreview: 'short',
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

describe('<SourcesViewer> accordion', () => {
  it('renders empty state when no turns have provenance', () => {
    const { lastFrame } = render(createElement(SourcesViewer, { agent: makeAgent([]) }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No citations recorded yet.');
    expect(frame).toContain('esc close');
  });

  it('lists every turn collapsed by default — headers with source counts, no source rows', () => {
    const { lastFrame } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS) }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Turn 1 · tell me about Rust');
    expect(frame).toContain('Turn 2 · follow-up question');
    expect(frame).toContain('(2 sources)');
    expect(frame).toContain('(1 source)');
    // Collapsed → no source rows rendered yet.
    expect(frame).not.toContain('[^S1]');
    expect(frame).not.toContain('rust-lang.org');
  });

  it('expands the focused turn on Enter, revealing its sources', async () => {
    const { stdin, lastFrame } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS) }),
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▾ Turn 1'); // expanded marker
    expect(frame).toContain('[^S1]');
    expect(frame).toContain('rust-lang.org'); // S1 (cited)
    expect(frame).toContain('rust-fact-1'); // S2 (uncited) — both render
    // Turn 2 stays collapsed.
    expect(frame).not.toContain('shell:cargo --version');
  });

  it('moves the cursor with the down arrow and expands the newly-focused turn', async () => {
    const { stdin, lastFrame } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS) }),
    );
    await tick();
    stdin.write(ARROW_DOWN); // focus Turn 2
    await tick();
    stdin.write(ENTER); // expand Turn 2
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▾ Turn 2');
    expect(frame).toContain('shell:cargo --version');
    // Turn 1 stays collapsed.
    expect(frame).not.toContain('rust-lang.org');
  });

  it('renders the empty-sources hint when an expanded turn registered nothing', async () => {
    const turns: TurnProvenance[] = [
      { turnIndex: 0, userInput: 'hi', sources: [], citedIds: [], timestamp: 0 },
    ];
    const { stdin, lastFrame } = render(createElement(SourcesViewer, { agent: makeAgent(turns) }));
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('(no sources registered)');
  });

  it('truncates a long rawRef and contentPreview in an expanded source', async () => {
    const { stdin, lastFrame } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS) }),
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('…');
    expect(frame).not.toContain(PREVIEW); // full 300-char preview never shown verbatim
  });

  it('windows a long collapsed history and scrolls to reveal later turns', async () => {
    // 25 collapsed headers > the 17-row viewport, so the last turns start hidden.
    const turns: TurnProvenance[] = Array.from({ length: 25 }, (_, i) => ({
      turnIndex: i,
      userInput: `req-${i}`,
      sources: [{ id: 'S1', kind: 'web', label: `src-${i}`, timestamp: 0 }],
      citedIds: ['S1'],
      timestamp: 0,
    }));
    const { stdin, lastFrame } = render(createElement(SourcesViewer, { agent: makeAgent(turns) }));
    let frame = lastFrame() ?? '';
    expect(frame).toContain('Turn 1 ·');
    expect(frame).not.toContain('Turn 25 ·');
    // Jump the cursor to the last turn — it scrolls into view.
    await tick();
    stdin.write('G');
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).toContain('Turn 25 ·');
  });
});
