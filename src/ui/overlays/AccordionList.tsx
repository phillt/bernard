import { type ReactNode, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors, type ThemeColors } from '../../theme.js';
import type { OverlayLine } from './ViewerShell.js';

/**
 * One node in an accordion tree. A node renders as a single header row with a
 * `▸`/`▾` disclosure marker (drawn by the list, not the caller); expanding it
 * reveals its `children` (nested one level deeper) and/or its `detail` rows.
 * Leaf nodes (no children, no detail) render without a marker and aren't
 * expandable.
 */
export interface AccordionItem {
  /** Stable id, unique across the whole tree. React key + expand-state token. */
  id: string;
  /** One-line header content. Receives whether this row is the cursor target. */
  header: (selected: boolean) => ReactNode;
  /** Nested child nodes revealed when this node is expanded. */
  children?: AccordionItem[];
  /** Leaf detail rows revealed when expanded. Each node MUST be one terminal line. */
  detail?: OverlayLine[];
}

export interface AccordionResult {
  /** The already-windowed visible rows — render these inside a `ViewerShell`. */
  rows: OverlayLine[];
  /** Scroll position for the shell, or `null` when everything fits. */
  position: { first: number; last: number; total: number } | null;
}

/** Columns of indentation added per nesting level. */
const INDENT = 2;

function isExpandable(item: AccordionItem): boolean {
  return Boolean(item.children?.length || item.detail?.length);
}

interface NavRow {
  id: string;
  depth: number;
  /** Index of this header within the flat `rows` list. */
  rowIndex: number;
  expandable: boolean;
}

/**
 * Walks the tree in display order under the current `expanded` set, producing
 * the flat row list and the navigable-header index. `selectedId` only drives
 * header styling, so structure (row positions, nav order) depends on `expanded`
 * alone — callers that need only structure can pass `undefined`.
 */
function build(
  items: AccordionItem[],
  expanded: Set<string>,
  selectedId: string | undefined,
  colors: ThemeColors,
): { rows: OverlayLine[]; nav: NavRow[] } {
  const rows: OverlayLine[] = [];
  const nav: NavRow[] = [];
  const walk = (nodes: AccordionItem[], depth: number) => {
    for (const item of nodes) {
      const expandable = isExpandable(item);
      const open = expanded.has(item.id);
      const selected = item.id === selectedId;
      nav.push({ id: item.id, depth, rowIndex: rows.length, expandable });
      rows.push({
        key: item.id,
        node: (
          <Box marginLeft={depth * INDENT}>
            <Text color={selected ? colors.accent : undefined} bold={selected} dimColor={!selected}>
              {expandable ? (open ? '▾ ' : '▸ ') : '  '}
            </Text>
            {item.header(selected)}
          </Box>
        ),
      });
      if (!open) continue;
      if (item.children?.length) walk(item.children, depth + 1);
      if (item.detail?.length) {
        for (const d of item.detail) {
          rows.push({
            key: `${item.id}::${d.key}`,
            node: <Box marginLeft={(depth + 1) * INDENT}>{d.node}</Box>,
          });
        }
      }
    }
  };
  walk(items, 0);
  return { rows, nav };
}

/**
 * Reusable nested-accordion list. Owns cursor selection (over navigable
 * headers), per-node expand/collapse, vertical scroll, and the navigation
 * keystream (`↑/↓`/`j`/`k`, `PgUp`/`PgDn`, `g`/`G`, `←/→`, `Enter`/`Space`).
 * Esc / Shift-Tab belong to the surrounding `ViewerShell`.
 *
 * Returns the windowed rows + scroll position so the caller can drop them into
 * a `ViewerShell`. The shared accordion look across the UI — `SourcesViewer` and
 * future tree overlays build `AccordionItem[]` and render the result; the
 * disclosure markers, indentation, highlight, and scroll math live here once.
 */
export function useAccordion(opts: {
  items: AccordionItem[];
  /** Content rows available (from `viewerViewport`). */
  viewport: number;
  /** Node ids expanded on first render (e.g. top-level groups). */
  initialExpanded?: Set<string>;
  /** Whether the navigation keystream is live (default true). */
  isActive?: boolean;
}): AccordionResult {
  const { items, viewport, isActive = true } = opts;
  const colors = getThemeColors();
  const [expanded, setExpanded] = useState<Set<string>>(() => opts.initialExpanded ?? new Set());
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [offset, setOffset] = useState(0);

  // Structure pass (styling-independent) to resolve the navigable headers, then
  // the styled pass once we know which id is selected.
  const { nav } = build(items, expanded, undefined, colors);
  const clampedIdx = Math.min(selectedIdx, Math.max(0, nav.length - 1));
  const selectedId = nav[clampedIdx]?.id;
  const { rows } = build(items, expanded, selectedId, colors);

  // Re-aim the scroll so the selected header's block stays visible. Keeps the
  // whole block on screen when it fits; otherwise pins the header to the top.
  const ensureVisible = (idx: number, exp: Set<string>) => {
    const meta = build(items, exp, undefined, colors);
    const total = meta.rows.length;
    const start = meta.nav[idx]?.rowIndex ?? 0;
    const depth = meta.nav[idx]?.depth ?? 0;
    let end = total;
    for (let j = idx + 1; j < meta.nav.length; j++) {
      if (meta.nav[j].depth <= depth) {
        end = meta.nav[j].rowIndex;
        break;
      }
    }
    const maxOff = Math.max(0, total - viewport);
    setOffset((off) => {
      const o = Math.min(off, maxOff);
      const fits = start >= o && end - 1 < o + viewport;
      return fits ? o : Math.min(maxOff, start);
    });
  };

  const move = (delta: number) => {
    if (nav.length === 0) return;
    const next = Math.max(0, Math.min(nav.length - 1, clampedIdx + delta));
    setSelectedIdx(next);
    ensureVisible(next, expanded);
  };

  const setOpen = (open: boolean | 'toggle') => {
    const row = nav[clampedIdx];
    if (!row || !row.expandable) return;
    const willOpen = open === 'toggle' ? !expanded.has(row.id) : open;
    const next = new Set(expanded);
    if (willOpen) next.add(row.id);
    else next.delete(row.id);
    setExpanded(next);
    ensureVisible(clampedIdx, next);
  };

  useInput(
    (input, key) => {
      if (nav.length === 0) return;
      if (key.downArrow || input === 'j') move(1);
      else if (key.upArrow || input === 'k') move(-1);
      else if (key.pageDown) move(viewport);
      else if (key.pageUp) move(-viewport);
      else if (input === 'g') move(-nav.length);
      else if (input === 'G') move(nav.length);
      else if (key.rightArrow) setOpen(true);
      else if (key.leftArrow) setOpen(false);
      else if (key.return || input === ' ') setOpen('toggle');
    },
    { isActive },
  );

  const maxOffset = Math.max(0, rows.length - viewport);
  const clampedOffset = Math.min(offset, maxOffset);
  const visible = rows.slice(clampedOffset, clampedOffset + viewport);
  const position =
    rows.length > viewport
      ? {
          first: clampedOffset + 1,
          last: Math.min(rows.length, clampedOffset + viewport),
          total: rows.length,
        }
      : null;

  return { rows: visible, position };
}
