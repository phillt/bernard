import type { MenuEntry, MenuItem } from '../menu-types.js';
import { viewerFrameHeight, wrapText } from './viewer-util.js';

/**
 * Pure row arithmetic for the two free-standing overlays that window their own
 * content — `MenuOverlay` and `ModelGridOverlay` (#266). No React, no Ink: the
 * `line-geometry.ts` doctrine, so these tests need neither.
 *
 * **The simplification that deletes an algorithm.** `MenuOverlay`'s rows look
 * non-uniform — section headers render as rows, and the HIGHLIGHTED item
 * renders its `description` on a second line — which invites a bespoke
 * variable-cost windowing pass. It should not have one. Every entry renders
 * exactly one row EXCEPT the highlighted one, which renders two when it has a
 * description; so the total is *uniform plus a constant*. **Reserve one row for
 * the description and `viewer-util.clampOffset` applies as-is**, unmodified,
 * over entry indices. The cost is one wasted row when the highlighted entry has
 * no description. What it buys is the removal of the whole variable-cost
 * algorithm and its worst failure mode: a window that visibly breathes — rows
 * appearing and disappearing at the bottom edge — as the highlight passes over
 * described entries.
 *
 * **Two coordinate spaces.** The cursor lives in ITEM space (sections excluded:
 * that is what the printed number, the digit shortcut and `checked.has(i)` all
 * key off) while the window lives in ENTRY space (sections included: they
 * occupy rows). {@link entryIndexOfItem} and {@link countItemsBefore} are the
 * only conversion between them, and they are pure functions rather than inline
 * filters precisely because getting the second one wrong ticks the wrong box in
 * a scrolled multi-select.
 */

export function isSection(entry: MenuEntry): entry is { type: 'section'; title: string } {
  return 'type' in entry && entry.type === 'section';
}

/** The selectable rows, in order — the ITEM space the cursor indexes. */
export function itemsOf(entries: readonly MenuEntry[]): MenuItem[] {
  return entries.filter((e): e is MenuItem => !isSection(e));
}

/**
 * ENTRY index of the `itemIndex`-th selectable row. Out-of-range item indices
 * clamp to `0` / the last entry, so a cursor that has outrun a shrinking list
 * still produces a window rather than `-1`.
 */
export function entryIndexOfItem(entries: readonly MenuEntry[], itemIndex: number): number {
  if (itemIndex <= 0) {
    const first = entries.findIndex((e) => !isSection(e));
    return first === -1 ? 0 : first;
  }
  let seen = -1;
  for (let i = 0; i < entries.length; i++) {
    if (isSection(entries[i])) continue;
    seen++;
    if (seen === itemIndex) return i;
  }
  return Math.max(0, entries.length - 1);
}

/**
 * How many selectable rows sit strictly before `entryIndex`. This is the value
 * `MenuList` seeds its running item counter with when it renders a window that
 * does not start at entry 0 — seeding `0` instead is the single highest-risk
 * mistake available here, because the printed number, the digit shortcut's
 * target and the checkbox state all read from that counter.
 */
export function countItemsBefore(entries: readonly MenuEntry[], entryIndex: number): number {
  const end = Math.max(0, Math.min(entryIndex, entries.length));
  let n = 0;
  for (let i = 0; i < end; i++) if (!isSection(entries[i])) n++;
  return n;
}

/**
 * Terminal rows a block of chrome text actually occupies.
 *
 * Counted rather than hard-coded because a title, an `ask_user` header line or
 * the grid's catalog footer can soft-wrap to two rows and silently eat a row
 * out of the content budget — which is the same class of bug as budgeting the
 * tool block at zero. `undefined` / empty entries are skipped so a caller can
 * pass optional props straight through.
 */
export function chromeRows(
  lines: ReadonlyArray<string | undefined>,
  usableColumns: number,
): number {
  const width = Math.max(1, usableColumns);
  let rows = 0;
  for (const line of lines) {
    if (line === undefined || line === '') continue;
    rows += wrapText(line, width).length;
  }
  return rows;
}

/**
 * Content rows available to a free-standing overlay: the frame bound minus the
 * chrome the overlay itself renders.
 *
 * Deliberately NOT `viewer-util.viewerViewport` — that one charges 3-5 rows for
 * the position line, separator rules, tab strip and key legend that
 * `ViewerShell` draws, and neither `MenuOverlay` nor `ModelGridOverlay` is
 * inside a shell. Each counts its own chrome and passes the total here.
 */
export function overlayViewport(termRows: number, chrome: number): number {
  return Math.max(1, viewerFrameHeight(termRows) - Math.max(0, chrome));
}

/**
 * Pull a section header back into view when it sits immediately above the
 * window, so an item never orphans from the group that names it.
 *
 * Only when a row is spare: moving the window up by one pushes its last row
 * out, so the cursor must not be sitting on that row. Returns `offset`
 * unchanged when there is nothing to pull back or no room to do it.
 */
export function pullBackSection(
  entries: readonly MenuEntry[],
  offset: number,
  size: number,
  cursorEntry: number,
): number {
  if (offset <= 0 || size <= 1) return offset;
  if (isSection(entries[offset])) return offset;
  if (!isSection(entries[offset - 1])) return offset;
  // The cursor would fall off the bottom edge — keeping it visible outranks
  // keeping its section header visible.
  if (cursorEntry > offset + size - 2) return offset;
  return offset - 1;
}
