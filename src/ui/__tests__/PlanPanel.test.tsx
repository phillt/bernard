import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import stripAnsi from 'strip-ansi';
import { PlanPanel } from '../PlanPanel.js';
import type { Agent } from '../../agent.js';
import { PlanStore } from '../../plan-store.js';
import { FALLBACK_DIMENSIONS } from '../useDimensions.js';
import { PLAN_CHROME_ROWS, planListRows, planPanelMaxRows } from '../plan-window.js';
import { PROMPT_BORDER_COLUMNS } from '../Prompt.js';
import { frameRows, tick } from './_keys.js';

function makeAgent(store: PlanStore): Agent {
  return {
    getPlanSnapshot: () => store.view(),
    subscribeToPlanStore: (cb: () => void) => store.subscribe(cb),
  } as unknown as Agent;
}

/**
 * Mounted bare, so `useDimensionsCtx` returns the 80×24 `FALLBACK_DIMENSIONS`
 * while ink-testing-library's own stdout reports 100 columns. That gap is
 * deliberate here: the panel's horizontal cap is computed from the context's
 * 80, so a row that ends in `…` proves the ARITHMETIC cut it, not Ink's
 * `wrap="truncate"` backstop hitting the frame edge.
 *
 * `maxRows` is a required prop — it flows down from `Prompt`, which owns the
 * border — so every mount states the budget it is testing against. The default
 * is what production computes for a 24-row terminal.
 */
const DEFAULT_MAX_ROWS = planPanelMaxRows(FALLBACK_DIMENSIONS.rows);

function mountPanel(store: PlanStore, maxRows: number = DEFAULT_MAX_ROWS) {
  return render(
    createElement(PlanPanel, {
      agent: makeAgent(store),
      maxRows,
      reserveColumns: PROMPT_BORDER_COLUMNS,
    }),
  );
}

/** A description long enough to soft-wrap several times if nothing bounds it. */
const LONG = 'x'.repeat(400);

function seedPending(store: PlanStore, names: string[]) {
  store.create(names.map((description) => ({ description, verification: 'v' })));
}

describe('<PlanPanel>', () => {
  it('renders nothing when the plan is empty', () => {
    const { lastFrame } = mountPanel(new PlanStore());
    expect(lastFrame()).toBe('');
  });

  it('renders one row per step with status icons', () => {
    const store = new PlanStore();
    seedPending(store, ['first step', 'second step', 'third step']);
    store.update(1, 'done', { signoff: 'verified thoroughly' });
    store.update(2, 'in_progress');
    // An explicit budget with room for all three, not the production number for
    // one terminal size: this test is about the status icons, and since the
    // frame budget started charging for the chrome outside the prompt box
    // (#435) a 24-row terminal windows a 3-step plan to two rows — which is
    // `planPanelMaxRows` working, and would fail this assertion for a reason
    // that has nothing to do with what it is checking.
    const { lastFrame } = mountPanel(store, PLAN_CHROME_ROWS + 3);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✔ 1. first step');
    expect(frame).toContain('▸ 2. second step');
    expect(frame).toContain('○ 3. third step');
  });

  it('shows a done/total header count', () => {
    const store = new PlanStore();
    seedPending(store, ['one', 'two', 'three']);
    store.update(1, 'done', { signoff: 'checked and confirmed' });
    const { lastFrame } = mountPanel(store);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('plan');
    expect(frame).toContain('1/3');
  });

  it('appends the note on cancelled and error steps', () => {
    const store = new PlanStore();
    seedPending(store, ['cancelled step', 'errored step']);
    store.update(1, 'cancelled', { note: 'permissions error' });
    store.update(2, 'error', { note: 'network down' });
    const { lastFrame } = mountPanel(store);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✘ 1. cancelled step');
    expect(frame).toContain('· permissions error');
    expect(frame).toContain('✘ 2. errored step');
    expect(frame).toContain('· network down');
  });

  it('updates live when the store mutates after render', async () => {
    const store = new PlanStore();
    const { lastFrame } = mountPanel(store);
    expect(lastFrame()).toBe('');

    seedPending(store, ['appears live', 'still pending']);
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
    seedPending(store, ['short lived']);
    const { lastFrame } = mountPanel(store);
    expect(lastFrame()).toContain('short lived');

    store.clear();
    await tick();
    expect(lastFrame()).toBe('');
  });
});

/**
 * The bound (#358). Before this the panel had NO height assertion at all and no
 * test used more than three short steps, so both axes of the defect — an
 * uncapped step count and a 400-character description wrapping to 6 rows —
 * were free to regress silently.
 */
describe('<PlanPanel> height bound', () => {
  it('a 10-step plan of maximal descriptions stays inside its budget', () => {
    const store = new PlanStore();
    seedPending(
      store,
      Array.from({ length: 10 }, (_, i) => `${i}-${LONG}`),
    );
    const { lastFrame } = mountPanel(store);
    // Unbounded this was 63 rows: 10 steps × 6 wrapped rows + chrome, nearly
    // three terminal-heights inside a `height={rows}` frame.
    expect(frameRows(lastFrame())).toBeLessThanOrEqual(DEFAULT_MAX_ROWS);
  });

  it('holds at every terminal height, not just the 24-row fallback', () => {
    const store = new PlanStore();
    seedPending(
      store,
      Array.from({ length: 25 }, (_, i) => `${i}-${LONG}`),
    );
    for (const termRows of [10, 16, 24, 40, 60, 120]) {
      const maxRows = planPanelMaxRows(termRows);
      const { lastFrame } = mountPanel(store, maxRows);
      expect(frameRows(lastFrame()), `terminal ${termRows} rows`).toBeLessThanOrEqual(maxRows);
    }
  });

  it('cuts a long description to one row rather than wrapping it', () => {
    const store = new PlanStore();
    seedPending(store, [LONG]);
    const { lastFrame } = mountPanel(store);
    const lines = stripAnsi(lastFrame() ?? '').split('\n');
    const body = lines.filter((l) => l.includes('x'));
    expect(body).toHaveLength(1);
    expect(body[0]).toContain('…');
    // Cut by the arithmetic (80-column context), not by the 100-column frame.
    expect(body[0].trimEnd().length).toBeLessThan(FALLBACK_DIMENSIONS.columns);
  });

  it('keeps a long failure note from crowding out the description it belongs to', () => {
    const store = new PlanStore();
    seedPending(store, ['deploy the thing']);
    store.update(1, 'error', { note: 'y'.repeat(400) });
    const { lastFrame } = mountPanel(store);
    const lines = stripAnsi(lastFrame() ?? '').split('\n');
    const body = lines.filter((l) => l.includes('deploy the thing'));
    expect(body).toHaveLength(1);
    expect(body[0]).toContain('·');
  });
});

describe('<PlanPanel> windowing', () => {
  const NAMES = [
    'alpha',
    'bravo',
    'charlie',
    'delta',
    'echo',
    'foxtrot',
    'golf',
    'hotel',
    'india',
    'juliett',
  ];

  it('keeps the in-progress step visible and scrolls the finished ones away', () => {
    const store = new PlanStore();
    seedPending(store, NAMES);
    for (let id = 1; id <= 7; id++) store.update(id, 'done', { signoff: 'verified in test' });
    store.update(8, 'in_progress');
    const { lastFrame } = mountPanel(store);
    const frame = lastFrame() ?? '';
    // The work happening right now is on screen…
    expect(frame).toContain('hotel');
    // …and the long-finished head is not, or nothing was windowed.
    expect(frame).not.toContain('alpha');
    expect(frameRows(frame)).toBeLessThanOrEqual(DEFAULT_MAX_ROWS);
  });

  it('says how many steps are hidden, in the plan’s own numbering', () => {
    const store = new PlanStore();
    seedPending(store, NAMES);
    for (let id = 1; id <= 7; id++) store.update(id, 'done', { signoff: 'verified in test' });
    store.update(8, 'in_progress');
    const visible = planListRows(DEFAULT_MAX_ROWS);
    const { lastFrame } = mountPanel(store);
    expect(lastFrame()).toContain(`steps ${8 - visible + 1}–8 of 10`);
  });

  it('reserves the position row even when the whole plan fits', () => {
    const store = new PlanStore();
    seedPending(store, ['one', 'two']);
    const { lastFrame } = mountPanel(store);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('of 2');
    // header + 2 steps + the (blank) position row + divider. Reserving it
    // unconditionally is what keeps the panel's height independent of the
    // budget that decides what is hidden.
    expect(frameRows(frame)).toBe(PLAN_CHROME_ROWS + 2);
  });
});
