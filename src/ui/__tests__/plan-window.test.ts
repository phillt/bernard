import { describe, it, expect } from 'vitest';
import type { Step, StepStatus } from '../../plan-store.js';
import {
  NOTE_MAX_WIDTH,
  NOTE_SEPARATOR,
  PLAN_CHROME_ROWS,
  PLAN_GUTTER_COLUMNS,
  activeStepIndex,
  planListRows,
  planPanelMaxRows,
  planWindow,
  splitStepWidth,
  stepTextWidth,
} from '../plan-window.js';

/**
 * No renderer and no terminal size — the `line-geometry.ts` / `menu-geometry.ts`
 * doctrine (#358). These assertions cover every terminal height, which a
 * rendered test cannot: a bare `render()` silently receives the 80×24
 * `FALLBACK_DIMENSIONS`, so a bound expressed only in a component can only ever
 * be exercised at one size.
 */

function steps(statuses: StepStatus[]): Step[] {
  return statuses.map((status, i) => ({
    id: i + 1,
    description: `step ${i + 1}`,
    verification: 'v',
    status,
  }));
}

const pending = (n: number) => steps(Array.from({ length: n }, () => 'pending' as StepStatus));

describe('planPanelMaxRows', () => {
  it('grants a quarter of the frame, less than the input line gets', () => {
    // The input's own budget, `BoundedLine`: max(3, min(10, floor(rows / 3))).
    for (const rows of [24, 40, 60]) {
      const input = Math.max(3, Math.min(10, Math.floor(rows / 3)));
      expect(planPanelMaxRows(rows)).toBeLessThan(input + PLAN_CHROME_ROWS);
    }
  });

  it('never returns less than chrome plus one step', () => {
    for (const rows of [1, 2, 5, 8, 12]) {
      expect(planPanelMaxRows(rows)).toBeGreaterThanOrEqual(PLAN_CHROME_ROWS + 1);
      expect(planListRows(planPanelMaxRows(rows))).toBeGreaterThanOrEqual(1);
    }
  });

  it('stops growing on a very tall terminal — the plan is reference material', () => {
    expect(planPanelMaxRows(200)).toBe(planPanelMaxRows(1000));
    expect(planPanelMaxRows(200)).toBeLessThanOrEqual(PLAN_CHROME_ROWS + 6);
  });

  it('is monotonic in terminal height', () => {
    let prev = 0;
    for (let rows = 1; rows <= 120; rows++) {
      const got = planPanelMaxRows(rows);
      expect(got).toBeGreaterThanOrEqual(prev);
      prev = got;
    }
  });
});

describe('activeStepIndex', () => {
  it('prefers the in_progress step', () => {
    expect(activeStepIndex(steps(['done', 'done', 'in_progress', 'pending']))).toBe(2);
  });

  it('falls back to the next pending step', () => {
    expect(activeStepIndex(steps(['done', 'done', 'pending', 'pending']))).toBe(2);
  });

  it('falls back to the tail once everything is terminal', () => {
    expect(activeStepIndex(steps(['done', 'error', 'cancelled']))).toBe(2);
  });

  it('is 0 for an empty plan', () => {
    expect(activeStepIndex([])).toBe(0);
  });
});

describe('planWindow', () => {
  it('shows the whole plan and suppresses the affordance when it fits', () => {
    const w = planWindow(pending(3), PLAN_CHROME_ROWS + 6);
    expect(w).toEqual({ offset: 0, size: 3, position: null });
  });

  it('bounds the visible steps by the row budget', () => {
    const w = planWindow(pending(40), PLAN_CHROME_ROWS + 4);
    expect(w.size).toBe(4);
    expect(w.offset + w.size).toBeLessThanOrEqual(40);
  });

  it('keeps the in_progress step inside the window', () => {
    const plan = steps([
      ...Array.from({ length: 9 }, () => 'done' as StepStatus),
      'in_progress',
      ...Array.from({ length: 10 }, () => 'pending' as StepStatus),
    ]);
    const w = planWindow(plan, PLAN_CHROME_ROWS + 3);
    expect(9).toBeGreaterThanOrEqual(w.offset);
    expect(9).toBeLessThan(w.offset + w.size);
  });

  it('reports what is hidden, in 1-based step numbers', () => {
    const plan = steps([
      ...Array.from({ length: 5 }, () => 'done' as StepStatus),
      'in_progress',
      ...Array.from({ length: 4 }, () => 'pending' as StepStatus),
    ]);
    const w = planWindow(plan, PLAN_CHROME_ROWS + 3);
    // Active step is index 5 → step 6, pinned to the last visible row.
    expect(w.position).toEqual({ first: 4, last: 6, total: 10 });
  });

  it('never windows past the end for a finished plan', () => {
    const w = planWindow(steps(Array.from({ length: 12 }, () => 'done' as StepStatus)), 6);
    expect(w.offset + w.size).toBe(12);
  });

  it('survives an empty plan without producing a negative window', () => {
    const w = planWindow([], 6);
    expect(w.offset).toBe(0);
    expect(w.size).toBeGreaterThanOrEqual(1);
    expect(w.position).toBeNull();
  });
});

describe('stepTextWidth / splitStepWidth', () => {
  it('subtracts the border, the gutters and the id cell', () => {
    expect(stepTextWidth(80, 2, 3)).toBe(80 - 2 - PLAN_GUTTER_COLUMNS - 3);
  });

  it('floors at a legible width on a pathologically narrow terminal', () => {
    expect(stepTextWidth(10, 2, 4)).toBe(8);
  });

  it('gives the whole row to the description when there is no note', () => {
    expect(splitStepWidth(60, false)).toEqual({ description: 60, note: 0 });
  });

  it('keeps description + separator + note inside one row', () => {
    for (const width of [8, 20, 40, 66, 120, 400]) {
      const { description, note } = splitStepWidth(width, true);
      expect(description + NOTE_SEPARATOR.length + note).toBeLessThanOrEqual(width);
      expect(description).toBeGreaterThanOrEqual(1);
      expect(note).toBeGreaterThanOrEqual(1);
    }
  });

  it('caps the note so a long reason cannot crowd out the step it belongs to', () => {
    const { note } = splitStepWidth(400, true);
    expect(note).toBeLessThanOrEqual(NOTE_MAX_WIDTH);
  });
});
