import { describe, it, expect } from 'vitest';
import { cell, renderRecordTable, type RichLine } from '../overlays/table.js';

/** The composed row as the terminal would show it, styling discarded. */
function text(line: RichLine): string {
  return line.map((s) => s.text).join('');
}

/** Roles of the non-separator spans, in order. */
function roles(line: RichLine): string[] {
  return line.filter((s) => s.text !== ' ').map((s) => s.role);
}

const ISSUES = [
  { id: '1', title: 'Fix the parser', state: 'open', author: 'ada' },
  { id: '2', title: 'Ship the viewer', state: 'closed', author: 'grace' },
];

describe('cell', () => {
  it('pads to width and truncates anything longer', () => {
    expect(cell('ab', 5)).toBe('ab   ');
    expect(cell('ab', 5, 'right')).toBe('   ab');
    expect(cell('abcdefgh', 5)).toHaveLength(5);
    expect(cell('abcdefgh', 5)).toContain('…');
  });
});

describe('renderRecordTable — shapes it refuses', () => {
  // Each of these must fall back so the caller keeps pretty-printed JSON: a bad
  // table is strictly worse than readable JSON.
  it.each([
    ['a non-array', { a: 1 }],
    ['an empty array', []],
    ['an array of scalars', [1, 2, 3]],
    ['an array of arrays', [[1], [2]]],
    ['an array of nulls', [null, null]],
    ['objects with only nested values', [{ meta: { x: 1 } }, { meta: { y: 2 } }]],
    ['an array too ragged to grid', [{ a: 1 }, { b: 2 }, { c: 3 }]],
  ])('returns null for %s', (_label, value) => {
    expect(renderRecordTable(value, 60)).toBeNull();
  });

  it('returns null when not even one column fits the width', () => {
    // Both sides of MIN_COL_W (4): a width that cannot seat the narrowest
    // possible column, and one that is exactly it but still too small for the
    // first candidate. One exit covers both.
    expect(renderRecordTable(ISSUES, 3)).toBeNull();
    expect(renderRecordTable(ISSUES, 0)).toBeNull();
    expect(renderRecordTable(ISSUES, -1)).toBeNull();
  });
});

describe('renderRecordTable — layout', () => {
  it('renders a header plus exactly one line per row', () => {
    const lines = renderRecordTable(ISSUES, 60)!;
    expect(lines).toHaveLength(1 + ISSUES.length);
    expect(text(lines[0])).toContain('title');
    expect(text(lines[1])).toContain('Fix the parser');
    expect(text(lines[2])).toContain('Ship the viewer');
  });

  it('never emits a line wider than the budget (the one-row invariant)', () => {
    for (const width of [10, 17, 24, 40, 200]) {
      for (const line of renderRecordTable(ISSUES, width) ?? []) {
        expect(text(line).length).toBeLessThanOrEqual(width);
      }
    }
  });

  it('orders columns by how many rows carry the field', () => {
    // `b` is in every row, `a` in one — so `b` leads regardless of key order.
    const lines = renderRecordTable([{ a: 1, b: 2 }, { b: 3 }, { b: 4 }], 60)!;
    // Both columns are numeric, so their headers ride the right edge too.
    expect(text(lines[0]).trim()).toMatch(/^b\s+a$/);
  });

  it('caps columns at the available width and names the ones it dropped', () => {
    // `id` + `title` fit in 24 columns; `state` and `author` do not.
    const lines = renderRecordTable(ISSUES, 24)!;
    const omitted = text(lines[lines.length - 1]);
    expect(omitted).toMatch(/^\+2 more fields:/);
    expect(omitted).toContain('state');
    // The sentinel obeys the same one-row budget as every other line — at a
    // width too small to name anything it truncates rather than wrapping.
    const narrow = renderRecordTable(ISSUES, 12)!;
    expect(text(narrow[narrow.length - 1])).toHaveLength(12);
  });

  it('drops a field that is ever non-scalar as a column, not as a table', () => {
    const lines = renderRecordTable([{ name: 'a', meta: { x: 1 } }], 60)!;
    expect(text(lines[0])).toContain('name');
    expect(text(lines[lines.length - 1])).toBe('+1 more field: meta');
  });

  it('leaves a missing key blank rather than dropping the row', () => {
    const lines = renderRecordTable([{ b: 'x', a: 'y' }, { b: 'z' }], 60)!;
    expect(lines).toHaveLength(3);
    expect(text(lines[2]).trimEnd()).toBe('z');
  });

  it('right-aligns a column only when every present value is a number', () => {
    const numeric = renderRecordTable([{ n: 1 }, { n: 22 }], 20)!;
    expect(text(numeric[2])).toBe('  22');
    // One string value in the column and it aligns left again.
    const mixed = renderRecordTable([{ n: 1 }, { n: 'x' }], 20)!;
    expect(text(mixed[2])).toBe('x   ');
  });
});

describe('renderRecordTable — field highlighting', () => {
  it('marks the common-key columns accent in the header and foreground in the body', () => {
    const lines = renderRecordTable(ISSUES, 60)!;
    // id, title, state are highlighted keys; author is not.
    expect(roles(lines[0])).toEqual(['accent', 'accent', 'accent', 'muted']);
    expect(roles(lines[1])).toEqual(['text', 'text', 'text', 'muted']);
  });
});
