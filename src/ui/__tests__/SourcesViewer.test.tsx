import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { SourcesViewer } from '../overlays/SourcesViewer.js';
import type { Agent } from '../../agent.js';
import type { TurnProvenance } from '../../provenance.js';

function makeAgent(turns: TurnProvenance[]): Agent {
  return { getTurnProvenance: () => turns } as unknown as Agent;
}

const PREVIEW = 'a'.repeat(300); // exercises the 160-char truncate at SourceRow

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

describe('<SourcesViewer>', () => {
  it('renders empty state when no turns have provenance', () => {
    const { lastFrame } = render(createElement(SourcesViewer, { agent: makeAgent([]) }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Sources');
    expect(frame).toContain('No citations recorded yet.');
    expect(frame).toContain('Esc to close · Shift-Tab to switch tabs');
  });

  it('renders every turn with its sources and user input', () => {
    const { lastFrame } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS) }),
    );
    const frame = lastFrame() ?? '';
    // Turn headers use 1-based numbering.
    expect(frame).toContain('Turn 1:');
    expect(frame).toContain('tell me about Rust');
    expect(frame).toContain('Turn 2:');
    expect(frame).toContain('follow-up question');
    expect(frame).toContain('[^S1]');
    expect(frame).toContain('[^S2]');
    expect(frame).toContain('(web)');
    expect(frame).toContain('(rag)');
    expect(frame).toContain('(tool-result)');
  });

  it('renders the empty-sources hint when a turn registered nothing', () => {
    const turns: TurnProvenance[] = [
      {
        turnIndex: 0,
        userInput: 'hi',
        sources: [],
        citedIds: [],
        timestamp: 0,
      },
    ];
    const { lastFrame } = render(createElement(SourcesViewer, { agent: makeAgent(turns) }));
    expect(lastFrame()).toContain('(no sources registered)');
  });

  it('truncates long rawRef and contentPreview', () => {
    const { lastFrame } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS) }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('…');
    // The full 300-char preview must NOT appear verbatim.
    expect(frame).not.toContain(PREVIEW);
  });

  it('renders all turns even when the latest turn cited nothing (regression #211)', () => {
    const { lastFrame } = render(
      createElement(SourcesViewer, { agent: makeAgent(REGRESSION_TURNS) }),
    );
    const frame = lastFrame() ?? '';
    // Both turns visible.
    expect(frame.indexOf('Turn 1:')).toBeLessThan(frame.indexOf('Turn 2:'));
    // Turn 1's S1 (cited) and S2 (uncited) both render.
    expect(frame).toContain('rust-lang.org');
    expect(frame).toContain('rust-fact-1');
  });
});
