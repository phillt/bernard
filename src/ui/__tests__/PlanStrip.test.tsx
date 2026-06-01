import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { PlanStrip } from '../PlanStrip.js';
import type { Agent } from '../../agent.js';
import type { Step } from '../../plan-store.js';

function makeAgent(steps: Step[]): Agent {
  return { getPlanSnapshot: () => steps } as unknown as Agent;
}

describe('<PlanStrip>', () => {
  it('renders nothing when the plan is empty', () => {
    const { lastFrame } = render(createElement(PlanStrip, { agent: makeAgent([]) }));
    expect(lastFrame()).toBe('');
  });

  it('renders the active step description with a done/total summary', () => {
    const steps = [
      { id: 1, status: 'done', description: 's1' },
      { id: 2, status: 'in_progress', description: 'currently doing' },
      { id: 3, status: 'pending', description: 's3' },
    ] as unknown as Step[];
    const { lastFrame } = render(createElement(PlanStrip, { agent: makeAgent(steps) }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('plan');
    expect(frame).toContain('1/3');
    expect(frame).toContain('currently doing');
  });

  it('falls back to the first pending step when none are in progress', () => {
    const steps = [
      { id: 1, status: 'done', description: 'one' },
      { id: 2, status: 'pending', description: 'awaiting' },
      { id: 3, status: 'pending', description: 'later' },
    ] as unknown as Step[];
    const { lastFrame } = render(createElement(PlanStrip, { agent: makeAgent(steps) }));
    expect(lastFrame()).toContain('awaiting');
  });

  it('renders summary only when every step is terminal', () => {
    const steps = [
      { id: 1, status: 'done', description: 'one' },
      { id: 2, status: 'done', description: 'two' },
    ] as unknown as Step[];
    const { lastFrame } = render(createElement(PlanStrip, { agent: makeAgent(steps) }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('plan');
    expect(frame).toContain('2/2');
  });
});
