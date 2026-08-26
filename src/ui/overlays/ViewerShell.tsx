import type { ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import { MenuRow } from './MenuRow.js';
import { HintRow, type KeyHint } from '../hints.js';
import { getThemeColors } from '../../theme.js';
import { useDimensionsCtx } from '../DimensionsContext.js';
import { isCtrlC } from './overlay-contract.js';

/** One pre-rendered visual row. `node` MUST occupy exactly one terminal line. */
export interface OverlayLine {
  key: string;
  node: ReactNode;
}

/** A selectable viewer tab rendered in the bottom tab menu. */
export interface OverlayTab {
  id: string;
  label: string;
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

interface ViewerShellProps {
  /** Shift-Tab tab menu rendered at the bottom. */
  tabs?: readonly OverlayTab[];
  /** `id` of the active tab — highlighted in the menu; the rest are muted. */
  activeTab?: string;
  /**
   * Scroll position shown directly above the tab menu (`rows X–Y of N`). `null`
   * keeps the row reserved (blank) so the layout height stays stable.
   */
  position: { first: number; last: number; total: number } | null;
  /** Key legend pinned to the very bottom, rendered via the shared {@link HintRow}. */
  keyHints: readonly KeyHint[];
  /** The (already-windowed) content rows. */
  children: ReactNode;
  onClose?: () => void;
  onCycleTab?: () => void;
  /**
   * Whether Esc closes the whole viewer. Defaults to `true`. A content
   * component with its own internal navigation (e.g. `SourcesViewer` drilled
   * into a turn) sets this `false` so its own `useInput` can claim Esc for
   * "go back" — Ink broadcasts every keypress to all active `useInput`s with no
   * stop-propagation, so without this gate the shell's Esc would close the
   * viewer at the same moment the inner handler tries to step back a level.
   * Shift-Tab tab-cycling stays live in both states.
   */
  escClosesViewer?: boolean;
}

/**
 * Shared full-screen chrome for the Shift-Tab viewer tabs (`StatusViewer`,
 * `SourcesViewer`). Renders the content area, then a bottom block: scroll
 * position, a separator rule, a horizontal tab menu (fenced by a second rule),
 * and a key legend. Owns the Esc / Shift-Tab keystream; the content component
 * layered inside owns its own navigation keys via a separate `useInput` (Ink
 * dispatches to both).
 *
 * The bottom chrome (scroll position, tab menu, key legend) is pinned to the
 * bottom of the available height via a `flexGrow` content region — so in
 * full-screen mode the tab menu sticks to the bottom of the frame the same way
 * the prompt does, instead of floating up under short content.
 *
 * Crucially the shell uses `flexGrow` rather than an explicit
 * `viewerFrameHeight(rows)` height. An earlier version pinned the Box to that
 * height to read as a full-screen "replacement" for the thread, but that
 * ballooned Ink's dynamic region from a few lines to nearly the whole screen on
 * open — and since the welcome splash and finalized turns live in terminal
 * scrollback *above* Ink's region in legacy mode (printed pre-Ink / via
 * `<Static>` — see `src/index.ts` `printWelcome` and `src/ui/Thread.tsx`), that
 * growth scrolled them off the top. `flexGrow` only distributes *free* space:
 * in full-screen the parent zone is height-constrained (`height={rows}` frame
 * in `App.tsx`) so the shell fills it and pins the chrome to the bottom; in
 * legacy mode the parent is content-sized, so `flexGrow` finds no free space
 * and the shell stays content-sized exactly as before. Either way the caller
 * windows content to `viewerViewport(rows)`, so the frame never exceeds the
 * screen.
 */
export function ViewerShell({
  tabs = [],
  activeTab,
  position,
  keyHints,
  children,
  onClose = () => {},
  onCycleTab = () => {},
  escClosesViewer = true,
}: ViewerShellProps) {
  const colors = getThemeColors();
  const { columns: cols } = useDimensionsCtx();
  // App wraps the overlay in paddingX={2}, so the usable width is cols - 4.
  const rule = '─'.repeat(Math.max(4, cols - 4));

  useInput((input, key) => {
    // Ctrl-C closes unconditionally. `escClosesViewer` exists so a drilled-in
    // viewer can spend Esc on "back one level", but there must still be one
    // key that always leaves — otherwise the only exit is a level-by-level
    // walk back out.
    if (isCtrlC(input, key)) {
      onClose();
      return;
    }
    if (key.escape) {
      if (escClosesViewer) onClose();
    } else if (key.shift && key.tab) onCycleTab();
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Content grows to absorb free space so the bottom chrome below is
          pinned to the bottom of the frame (like the prompt), instead of
          floating up under short content. Inert when the parent is
          content-sized (legacy mode) — see the component doc. */}
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
      <Text color={colors.muted}>
        {position ? `rows ${position.first}–${position.last} of ${position.total}` : ' '}
      </Text>
      <Text color={colors.muted}>{rule}</Text>
      {tabs.length > 0 && (
        <>
          <Box>
            {tabs.map((tab, i) => (
              <Box key={tab.id} marginRight={i < tabs.length - 1 ? 3 : 0}>
                <MenuRow selected={tab.id === activeTab} dimUnselected label={tab.label} />
              </Box>
            ))}
          </Box>
          <Text color={colors.muted}>{rule}</Text>
        </>
      )}
      <HintRow hints={keyHints} />
    </Box>
  );
}
