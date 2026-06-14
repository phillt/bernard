import type { ReactNode } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { MenuRow } from './MenuRow.js';

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
  const bottom = 1 /* position */ + 1 /* rule */ + (hasTabs ? 1 /* tab row */ + 1 /* rule */ : 0) + 1 /* hints */;
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
  /** Dim key legend pinned to the very bottom. */
  keyHints: string;
  /** The (already-windowed) content rows. */
  children: ReactNode;
  onClose?: () => void;
  onCycleTab?: () => void;
}

/**
 * Shared full-screen chrome for the Shift-Tab viewer tabs (`StatusViewer`,
 * `SourcesViewer`). Renders the content area, then a bottom block: scroll
 * position, a separator rule, a horizontal tab menu (fenced by a second rule),
 * and a key legend. Owns the Esc / Shift-Tab keystream; the content component
 * layered inside owns its own navigation keys via a separate `useInput` (Ink
 * dispatches to both).
 *
 * The shell sizes to its (already windowed) content rather than pinning to the
 * full terminal height. An earlier version pinned the Box to
 * `viewerFrameHeight(rows)` to read as a full-screen "replacement" for the
 * thread, but that ballooned Ink's dynamic region from a few lines to nearly
 * the whole screen on open. Since the welcome splash and finalized turns live
 * in terminal scrollback *above* Ink's region (printed pre-Ink / via `<Static>`
 * — see `src/index.ts` `printWelcome` and `src/ui/Thread.tsx`), that growth
 * scrolled them off the top; on close Ink shrank the region back and the prompt
 * was stranded at the top of an otherwise-blank screen. Sizing to content keeps
 * the region small, so closing the viewer restores the prior layout in place.
 * The caller still windows content to `viewerViewport(rows)`, so the frame can
 * never exceed the screen.
 */
export function ViewerShell({
  tabs = [],
  activeTab,
  position,
  keyHints,
  children,
  onClose = () => {},
  onCycleTab = () => {},
}: ViewerShellProps) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  // App wraps the overlay in paddingX={2}, so the usable width is cols - 4.
  const rule = '─'.repeat(Math.max(4, cols - 4));

  useInput((_input, key) => {
    if (key.escape) onClose();
    else if (key.shift && key.tab) onCycleTab();
  });

  return (
    <Box flexDirection="column">
      {children}
      <Text dimColor>
        {position ? `rows ${position.first}–${position.last} of ${position.total}` : ' '}
      </Text>
      <Text dimColor>{rule}</Text>
      {tabs.length > 0 && (
        <>
          <Box>
            {tabs.map((tab, i) => (
              <Box key={tab.id} marginRight={i < tabs.length - 1 ? 3 : 0}>
                <MenuRow selected={tab.id === activeTab} dimUnselected label={tab.label} />
              </Box>
            ))}
          </Box>
          <Text dimColor>{rule}</Text>
        </>
      )}
      <Text dimColor>{keyHints}</Text>
    </Box>
  );
}
