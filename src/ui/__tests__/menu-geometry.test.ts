import { describe, it, expect } from 'vitest';
import type { MenuEntry } from '../menu-types.js';
import {
  chromeRows,
  countItemsBefore,
  entryIndexOfItem,
  itemsOf,
  overlayViewport,
  pullBackSection,
} from '../overlays/menu-geometry.js';

/** Two sections around four items: entry indices 0..5, item indices 0..3. */
const ENTRIES: MenuEntry[] = [
  { type: 'section', title: 'Built-in' },
  { label: 'anthropic' },
  { label: 'openai' },
  { type: 'section', title: 'Custom' },
  { label: 'ollama' },
  { label: 'lmstudio' },
];

describe('item ↔ entry coordinate conversion', () => {
  it('maps each item index to the entry it renders at', () => {
    expect(entryIndexOfItem(ENTRIES, 0)).toBe(1);
    expect(entryIndexOfItem(ENTRIES, 1)).toBe(2);
    expect(entryIndexOfItem(ENTRIES, 2)).toBe(4);
    expect(entryIndexOfItem(ENTRIES, 3)).toBe(5);
  });

  it('round-trips: countItemsBefore(entryIndexOfItem(i)) === i', () => {
    for (let i = 0; i < itemsOf(ENTRIES).length; i++) {
      expect(countItemsBefore(ENTRIES, entryIndexOfItem(ENTRIES, i))).toBe(i);
    }
  });

  it('counts only selectable rows before an entry', () => {
    expect(countItemsBefore(ENTRIES, 0)).toBe(0);
    expect(countItemsBefore(ENTRIES, 1)).toBe(0); // the section is not an item
    expect(countItemsBefore(ENTRIES, 3)).toBe(2);
    expect(countItemsBefore(ENTRIES, 4)).toBe(2); // ditto for the second section
    expect(countItemsBefore(ENTRIES, ENTRIES.length)).toBe(4);
  });

  it('clamps rather than returning -1 for out-of-range input', () => {
    // A cursor that outran a shrinking list must still produce a window.
    expect(entryIndexOfItem(ENTRIES, -3)).toBe(1);
    expect(entryIndexOfItem(ENTRIES, 99)).toBe(ENTRIES.length - 1);
    expect(countItemsBefore(ENTRIES, -5)).toBe(0);
    expect(countItemsBefore(ENTRIES, 999)).toBe(4);
  });

  it('handles a list that is all sections, and an empty list', () => {
    const allSections: MenuEntry[] = [{ type: 'section', title: 'a' }];
    expect(itemsOf(allSections)).toEqual([]);
    expect(entryIndexOfItem(allSections, 0)).toBe(0);
    expect(countItemsBefore(allSections, 1)).toBe(0);
    expect(entryIndexOfItem([], 0)).toBe(0);
    expect(countItemsBefore([], 0)).toBe(0);
  });
});

describe('chromeRows', () => {
  it('charges one row for a line that fits', () => {
    expect(chromeRows(['Pick a model'], 40)).toBe(1);
  });

  it('counts the rows a long line actually wraps to, not a flat 1', () => {
    // The whole point: a title or the grid's catalog footer soft-wraps and
    // silently eats a row out of the content budget.
    expect(chromeRows(['x'.repeat(100)], 40)).toBe(3);
    expect(chromeRows([`${'word '.repeat(20)}`], 20)).toBeGreaterThan(1);
  });

  it('sums over several lines and skips absent/empty ones', () => {
    expect(chromeRows(['a', 'b', 'c'], 40)).toBe(3);
    expect(chromeRows([undefined, '', 'a'], 40)).toBe(1);
    expect(chromeRows([], 40)).toBe(0);
  });

  it('survives a zero or negative width', () => {
    expect(chromeRows(['abc'], 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('overlayViewport', () => {
  it('is the frame bound minus the overlay-rendered chrome', () => {
    // viewerFrameHeight(24) === 23.
    expect(overlayViewport(24, 5)).toBe(18);
    expect(overlayViewport(24, 0)).toBe(23);
  });

  it('never drops below 1, even on a 3-row terminal with more chrome than rows', () => {
    expect(overlayViewport(3, 10)).toBe(1);
    expect(overlayViewport(1, 0)).toBe(1);
  });

  it('ignores a negative chrome count rather than inflating the budget', () => {
    expect(overlayViewport(24, -5)).toBe(23);
  });
});

describe('pullBackSection', () => {
  it('pulls a header back in when the window starts on its first item', () => {
    // offset 4 is `ollama`, whose `Custom` header sits at 3 — pull it in.
    expect(pullBackSection(ENTRIES, 4, 3, 4)).toBe(3);
  });

  it('leaves the offset alone when the cursor would fall off the bottom', () => {
    // size 3, offset 4 → visible 4..6; the cursor at 6 is on the last row, so
    // shifting up by one would push it out. Keeping the cursor visible wins.
    expect(pullBackSection(ENTRIES, 4, 3, 6)).toBe(4);
  });

  it('does nothing at the top, on a section row, or with no header above', () => {
    expect(pullBackSection(ENTRIES, 0, 3, 0)).toBe(0);
    expect(pullBackSection(ENTRIES, 3, 3, 4)).toBe(3); // entries[3] is itself a section
    expect(pullBackSection(ENTRIES, 2, 3, 2)).toBe(2); // entries[1] is an item
  });

  it('does nothing when the window is a single row', () => {
    expect(pullBackSection(ENTRIES, 4, 1, 4)).toBe(4);
  });
});
