import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { PlanPanel } from '../PlanPanel.js';
import type { Agent } from '../../agent.js';
import { PlanStore } from '../../plan-store.js';
import { tick } from './_keys.js';

function makeAgent(store: PlanStore): Agent {
  return {
    getPlanSnapshot: () => store.view(),
    subscribeToPlanStore: (cb: () => void) => store.subscribe(cb),
  } as unknown as Agent;
}

describe('<PlanPanel>', () => {
  it('renders nothing when the plan is empty', () => {
    const { lastFrame } = render(createElement(PlanPanel, { agent: makeAgent(new PlanStore()) }));
    expect(lastFrame()).toBe('');
  });

  it('renders one row per step with status icons', () => {
    const store = new PlanStore();
    store.create([
      { description: 'first step', verification: 'v1' },
      { description: 'second step', verification: 'v2' },
      { description: 'third step', verification: 'v3' },
    ]);
    store.update(1, 'done', { signoff: 'verified thoroughly' });
    store.update(2, 'in_progress');
    const { lastFrame } = render(createElement(PlanPanel, { agent: makeAgent(store) }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✔ 1. first step');
    expect(frame).toContain('▸ 2. second step');
    expect(frame).toContain('○ 3. third step');
  });

  it('shows a done/total header count', () => {
    const store = new PlanStore();
    store.create([
      { description: 'one', verification: 'v' },
      { description: 'two', verification: 'v' },
      { description: 'three', verification: 'v' },
    ]);
    store.update(1, 'done', { signoff: 'checked and confirmed' });
    const { lastFrame } = render(createElement(PlanPanel, { agent: makeAgent(store) }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('plan');
    expect(frame).toContain('1/3');
  });

  it('appends the note on cancelled and error steps', () => {
    const store = new PlanStore();
    store.create([
      { description: 'cancelled step', verification: 'v' },
      { description: 'errored step', verification: 'v' },
    ]);
    store.update(1, 'cancelled', { note: 'permissions error' });
    store.update(2, 'error', { note: 'network down' });
    const { lastFrame } = render(createElement(PlanPanel, { agent: makeAgent(store) }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✘ 1. cancelled step');
    expect(frame).toContain('· permissions error');
    expect(frame).toContain('✘ 2. errored step');
    expect(frame).toContain('· network down');
  });

  it('updates live when the store mutates after render', async () => {
    const store = new PlanStore();
    const { lastFrame } = render(createElement(PlanPanel, { agent: makeAgent(store) }));
    expect(lastFrame()).toBe('');

    store.create([
      { description: 'appears live', verification: 'v' },
      { description: 'still pending', verification: 'v' },
    ]);
    await tick();
    expect(lastFrame()).toContain('○ 1. appears live');

    store.update(1, 'done', { signoff: 'verified by test run' });
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✔ 1. appears live');
    expect(frame).toContain('1/2');
  });

  it('disappears when the store is cleared', async () => {
    const store = new PlanStore();
    store.create([{ description: 'short lived', verification: 'v' }]);
    const { lastFrame } = render(createElement(PlanPanel, { agent: makeAgent(store) }));
    expect(lastFrame()).toContain('short lived');

    store.clear();
    await tick();
    expect(lastFrame()).toBe('');
  });
});
