import type { Key } from 'ink';

/**
 * Shared pure helpers for the Shift+Tab viewer tabs (`SourcesViewer`,
 * `ContextViewer`): list-navigation key mapping, cursor/window clamping,
 * scroll-position formatting, and greedy word-wrap. No React, no side effects —
 * kept in one place so both two-panel viewers behave identically.
 *
 * The two frame/viewport helpers below moved here from `ViewerShell.tsx` (#266)
 * for the reason `line-geometry.ts` gives at its own head: `menu-geometry.ts`
 * builds on `viewerFrameHeight`, and leaving it in a `.tsx` would drag React and
 * Ink into a pure-arithmetic test suite that needs neither. `ViewerShell` still
 * re-exports both, so its existing importers are untouched.
 */

/**
 * The list-navigation keystream shared by every viewer pane: ↑/↓ (or j/k) by
 * one, PgUp/PgDn by a page, g/G to the ends. Returns the signed delta to apply,
 * or `null` if the key isn't a movement key. g/G return ±`total` so a clamped
 * consumer lands on the first/last item.
 */
export function navDelta(input: string, key: Key, pageSize: number, total: number): number | null {
  if (key.downArrow || input === 'j') return 1;
  if (key.upArrow || input === 'k') return -1;
  if (key.pageDown) return pageSize;
  if (key.pageUp) return -pageSize;
  if (input === 'g') return -total;
  if (input === 'G') return total;
  return null;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

/**
 * Upper bound for the overlay frame, used only to size the content viewport
 * (see {@link viewerViewport}). Always one short of the terminal: a dynamic
 * (non-Static) Ink frame that fills the last row can't be erased cleanly — the
 * trailing newline scrolls the terminal and desyncs the cursor math, leaving
 * stale rows after the overlay closes.
 *
 * NOTE: the shell deliberately does NOT pin its Box to this height — see the
 * `ViewerShell` body for why. This is a windowing bound, not a layout height.
 */
export function viewerFrameHeight(rows: number): number {
  return Math.max(1, rows - 1);
}

/**
 * How many content rows fit above the bottom chrome. Bottom chrome is always the
 * scroll-position line + a separator rule + the key hints (3 rows); a non-empty
 * tab menu adds a single horizontal tab row plus a second separator.
 *
 * Only for content rendered *inside* `ViewerShell` — it charges for chrome the
 * shell renders. A free-standing overlay (`MenuOverlay`, `ModelGridOverlay`)
 * counts its own chrome via `menu-geometry.overlayViewport` instead.
 */
export function viewerViewport(rows: number, opts: { tabCount?: number } = {}): number {
  const { tabCount = 0 } = opts;
  const hasTabs = tabCount > 0;
  const bottom =
    1 /* position */ +
    1 /* rule */ +
    (hasTabs ? 1 /* tab row */ + 1 /* rule */ : 0) +
    1; /* hints */
  return Math.max(1, viewerFrameHeight(rows) - bottom);
}

/** Keep the cursor visible: scroll the window only when it would fall off an edge. */
export function clampOffset(cursor: number, offset: number, size: number, total: number): number {
  const maxOffset = Math.max(0, total - size);
  let o = Math.min(offset, maxOffset);
  if (cursor < o) o = cursor;
  else if (cursor >= o + size) o = cursor - size + 1;
  return clamp(o, 0, maxOffset);
}

export function listPosition(
  offset: number,
  size: number,
  total: number,
): { first: number; last: number; total: number } | null {
  if (total <= size) return null;
  return { first: offset + 1, last: Math.min(total, offset + size), total };
}

/**
 * Greedy word-wrap that preserves paragraph breaks, keeps each paragraph's
 * leading indentation on its continuation lines (so pretty-printed JSON stays
 * readable), and hard-splits overlong words.
 */
export function wrapText(s: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const para of s.split('\n')) {
    if (para.trim() === '') {
      out.push('');
      continue;
    }
    const leading = para.match(/^[ \t]*/)?.[0] ?? '';
    const rawIndent = leading.replace(/\t/g, '  ');
    const indent = rawIndent.length > w - 1 ? rawIndent.slice(0, w - 1) : rawIndent;
    const avail = Math.max(1, w - indent.length);
    const content = para.slice(leading.length);
    let line = '';
    const flush = () => {
      out.push(indent + line);
      line = '';
    };
    for (const word of content.split(/\s+/).filter(Boolean)) {
      let token = word;
      while (token.length > avail) {
        if (line) flush();
        out.push(indent + token.slice(0, avail));
        token = token.slice(avail);
      }
      if (!line) line = token;
      else if (line.length + 1 + token.length <= avail) line += ` ${token}`;
      else {
        flush();
        line = token;
      }
    }
    if (line) flush();
  }
  return out;
}
