import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import { KEY, HINT_SELECT } from '../hints.js';
import { isDismissKeyWithQ } from './overlay-contract.js';
import { useListCursor, useListWindow } from './use-list-cursor.js';
import { chromeRows, overlayViewport } from './menu-geometry.js';
import { listPosition } from './viewer-util.js';
import { useDimensionsCtx } from '../DimensionsContext.js';
import { truncate } from '../../text.js';
import { MenuRow } from './MenuRow.js';
import { OverlayFooter, OVERLAY_FOOTER_ROWS } from './OverlayFooter.js';

export interface ModelGridOverlayProps {
  title?: string;
  footer?: string;
  items: string[];
  initialIndex?: number;
  currentItem?: string;
  onSelect: (index: number) => void;
  onCancel: () => void;
  /**
   * Rows consumed by chrome OUTSIDE this overlay, which only the caller knows:
   * the alert banner, and legacy inline mode where the overlay is appended
   * below the live prompt instead of replacing it. Same shape and reasoning as
   * `BoundedLine`'s `reserveColumns` — each caller passes its own because only
   * it knows what box it sits in.
   */
  reserveRows?: number;
}

const MIN_TERM_WIDTH = 50;
const CELL_GUTTER = 4;
const MAX_COLUMNS = 4;

function computeColumns(termWidth: number, longestItemLen: number): number {
  if (termWidth < MIN_TERM_WIDTH) return 1;
  const usable = Math.max(1, termWidth - 4);
  const cellWidth = longestItemLen + CELL_GUTTER;
  return Math.max(1, Math.min(MAX_COLUMNS, Math.floor(usable / cellWidth)));
}

/**
 * Sister to `MenuOverlay`, but lays items out in a width-adaptive grid.
 *
 * Built for the lineup model picker where one provider can have 40+ models
 * and a single column scrolls off-screen. The grid keeps the eye-saccade
 * count low while staying within `MenuOverlay`'s keyboard idioms (Esc / q
 * cancel, Enter commits). Cancellation from a parent is the caller's business:
 * `requestGridMenu` resolves the promise and unmounts, rather than this
 * component subscribing to a signal of its own (#266).
 */
export function ModelGridOverlay({
  title,
  footer,
  items,
  initialIndex = 0,
  currentItem,
  onSelect,
  onCancel,
  reserveRows = 0,
}: ModelGridOverlayProps) {
  const colors = getThemeColors();
  // Terminal size comes from the context, never `useStdout`: the context is the
  // one reactive source (it subscribes to SIGWINCH once at the top of the tree),
  // and under the test renderer the two disagree — no provider falls back to 80
  // columns while ink-testing-library's stdout reports 100.
  const { columns: termWidth, rows: termRows } = useDimensionsCtx();

  const longestItemLen = items.reduce((m, s) => Math.max(m, s.length), 1);
  const columns = computeColumns(termWidth, longestItemLen);
  const cellWidth = Math.min(
    longestItemLen + CELL_GUTTER,
    Math.max(8, Math.floor((termWidth - 4) / columns)),
  );

  // A grid is one flat list read in row-major order, so the shared keystream
  // covers it with two options: ↑/↓ step a whole row (`step: columns`), ←/→ are
  // ordinary ±1 cursor movement (`horizontal: 'move'`), and no digits — a grid
  // prints no row numbers, so there is nothing for one to name. `total === 0`
  // now subsumes the hand-rolled empty-list early-out this replaced.
  const { index: highlight, handleKey } = useListCursor({
    total: items.length,
    initialIndex,
    step: columns,
    horizontal: 'move',
    digits: false,
    onCommit: onSelect,
  });

  useInput((input, key) => {
    if (isDismissKeyWithQ(input, key)) {
      onCancel();
      return;
    }
    handleKey(input, key);
  });

  const rows: number[][] = [];
  for (let i = 0; i < items.length; i += columns) {
    rows.push(items.slice(i, i + columns).map((_, j) => i + j));
  }

  // Windowing (#266). Every grid row is exactly one terminal line by
  // construction, so `clampOffset` / `listPosition` apply verbatim over grid-row
  // indices — no coordinate translation beyond `index → floor(index/columns)`.
  // Unwindowed, a 58-model provider rendered 58 rows at ≤50 columns (one column,
  // one model per row), which is every lineup-slot edit on a narrow terminal.
  //
  // App wraps the overlay in paddingX={2}, so the usable width is termWidth - 4.
  // The title and footer are MEASURED rather than charged a flat row each: the
  // catalog footer routinely soft-wraps to two, and a constant would silently
  // hand back a row the frame does not have.
  const usableColumns = termWidth - 4;
  const chrome =
    1 /* the marginTop below */ +
    chromeRows([title, footer], usableColumns) +
    (title ? 1 : 0) /* blank after title */ +
    (footer ? 1 : 0) /* blank after footer */ +
    OVERLAY_FOOTER_ROWS /* blank + position line + HintRow */ +
    reserveRows;
  const viewport = overlayViewport(termRows, chrome);
  const cursorRow = Math.floor(highlight / columns);
  const { offset } = useListWindow(cursorRow, viewport, rows.length);
  const visibleRows = rows.slice(offset, offset + viewport);
  const position = listPosition(offset, viewport, rows.length);

  return (
    <Box flexDirection="column" marginTop={1}>
      {title && (
        <>
          <Text color={colors.accent} bold>
            {title}
          </Text>
          <Text> </Text>
        </>
      )}
      {footer && (
        <>
          <Text dimColor>{footer}</Text>
          <Text> </Text>
        </>
      )}
      <Box flexDirection="column">
        {visibleRows.map((row, rowIdx) => (
          <Box key={`r-${offset + rowIdx}`} flexDirection="row">
            {row.map((cellIndex) => {
              const value = items[cellIndex];
              const isCurrent = currentItem !== undefined && value === currentItem;
              const inner = `${value}${isCurrent ? ' *' : ''}`;
              const text = truncate(inner, cellWidth - 2);
              return (
                <MenuRow
                  key={`c-${cellIndex}`}
                  selected={cellIndex === highlight}
                  width={cellWidth}
                  label={text}
                />
              );
            })}
          </Box>
        ))}
      </Box>
      <OverlayFooter
        position={position ? `rows ${position.first}–${position.last} of ${position.total}` : null}
        hints={[
          { key: KEY.arrowsAll, label: 'move' },
          HINT_SELECT,
          { key: KEY.esc, label: 'back' },
          ...(currentItem !== undefined ? [{ key: '*', label: '= current' }] : []),
        ]}
      />
    </Box>
  );
}
