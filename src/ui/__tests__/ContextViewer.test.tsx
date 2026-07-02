import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { ENTER, ARROW_DOWN, ARROW_LEFT, tick } from './_keys.js';
import { ContextViewer } from '../overlays/ContextViewer.js';
import { DimensionsProvider } from '../DimensionsContext.js';
import type { Agent } from '../../agent.js';
import type { TurnContextRecord } from '../../turn-context.js';

function makeAgent(turns: TurnContextRecord[]): Agent {
  return { getTurnContext: () => turns } as unknown as Agent;
}

function renderViewer(agent: Agent) {
  return render(createElement(DimensionsProvider, null, createElement(ContextViewer, { agent })));
}

const TURNS: TurnContextRecord[] = [
  {
    turnIndex: 0,
    timestamp: 0,
    originalInput: "what's her bday",
    rewrittenInput: "What is my daughter Mia's birthday?",
    resolvedReferences: [{ phrase: 'her', resolvedTo: 'Mia', sourceKey: 'people/mia' }],
    recalledFacts: [{ fact: 'Mia was born 2018-03-04', similarity: 0.51, domain: 'general' }],
  },
  {
    turnIndex: 1,
    timestamp: 0,
    originalInput: 'thanks',
    rewrittenInput: 'thanks',
    resolvedReferences: [],
    recalledFacts: [],
  },
];

describe('ContextViewer', () => {
  it('shows an empty-state message when there are no turns', () => {
    const { lastFrame } = renderViewer(makeAgent([]));
    expect(lastFrame()).toContain('No prompt/context recorded yet.');
  });

  it('lists turns by original input and marks rewritten turns', () => {
    const { lastFrame } = renderViewer(makeAgent(TURNS));
    const frame = lastFrame() ?? '';
    expect(frame).toContain("Turn 1 · what's her bday");
    expect(frame).toContain('(rewritten)'); // turn 1 differs from original
    expect(frame).toContain('Turn 2 · thanks');
  });

  it('drills into a turn and shows the section list', async () => {
    const { stdin, lastFrame } = renderViewer(makeAgent(TURNS));
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Original input');
    expect(frame).toContain('Rewritten prompt');
    expect(frame).toContain('Resolved references (1)');
    expect(frame).toContain('Recalled facts (1)');
    // Right panel defaults to the first section's body.
    expect(frame).toContain("what's her bday");
  });

  it('shows resolved references and recalled facts in their section bodies', async () => {
    const { stdin, lastFrame } = renderViewer(makeAgent(TURNS));
    await tick();
    stdin.write(ENTER); // drill into turn 1
    await tick();
    stdin.write(ARROW_DOWN); // → Rewritten prompt
    await tick();
    stdin.write(ARROW_DOWN); // → Resolved references
    await tick();
    expect(lastFrame() ?? '').toContain('"her" → Mia');
    stdin.write(ARROW_DOWN); // → Recalled facts
    await tick();
    expect(lastFrame() ?? '').toContain('Mia was born 2018-03-04');
  });

  it('left arrow returns from sections to the turn list', async () => {
    const { stdin, lastFrame } = renderViewer(makeAgent(TURNS));
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame() ?? '').toContain('Original input');
    stdin.write(ARROW_LEFT);
    await tick();
    // Back at the list: the section labels are gone, turn rows are back.
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Turn 2 · thanks');
  });
});
