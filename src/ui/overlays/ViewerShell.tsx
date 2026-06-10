import type { ReactNode } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { getThemeColors } from '../../theme.js';

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

// Fixed chrome rows below the scrolling content area, excluding the tab rows
// themselves: scroll-position line + top border + bottom border + key hints.
const CHROME_BELOW_CONTENT = 4;

/**
 * Height of the overlay frame. Always one short of the terminal: a dynamic
 * (non-Static) Ink frame that fills the last row can't be erased cleanly — the
 * trailing newline scrolls the terminal and desyncs the cursor math, leaving
 * stale rows after the overlay closes.
 */
export function viewerFrameHeight(rows: number): number {
  return Math.max(1, rows - 1);
}

/** How many content rows fit above the bottom chrome (`tabCount` tab rows + fixed chrome). */
export function viewerViewport(rows: number, tabCount: number): number {
  return Math.max(1, viewerFrameHeight(rows) - tabCount - CHROME_BELOW_CONTENT);
}

interface ViewerShellProps {
  tabs: readonly OverlayTab[];
  /** `id` of the active tab — highlighted in the menu; the rest are muted. */
  activeTab: string;
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
 * Shared chrome for the Shift-Tab viewer tabs (`StatusViewer`, `SourcesViewer`).
 * Renders the content area, then a bottom block — scroll position, a vertical
 * tab menu fenced by top/bottom border rules, and a key legend. Owns the
 * Esc / Shift-Tab keystream; the content component layered inside owns its own
 * navigation keys via a separate `useInput` (Ink dispatches to both).
 *
 * The frame is pinned to `viewerFrameHeight(rows)` so it fills the screen and
 * reads as a replacement for the thread, while `<Thread>` stays mounted
 * (unmounting it would reprint `<Static>` scrollback — see `src/ui/Thread.tsx`).
 */
export function ViewerShell({
  tabs,
  activeTab,
  position,
  keyHints,
  children,
  onClose = () => {},
  onCycleTab = () => {},
}: ViewerShellProps) {
  const colors = getThemeColors();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 80;
  // App wraps the overlay in paddingX={2}, so the usable width is cols - 4.
  const rule = '─'.repeat(Math.max(4, cols - 4));

  useInput((_input, key) => {
    if (key.escape) onClose();
    else if (key.shift && key.tab) onCycleTab();
  });

  return (
    <Box flexDirection="column" height={viewerFrameHeight(rows)}>
      {children}
      <Box flexGrow={1} />
      <Text dimColor>
        {position ? `rows ${position.first}–${position.last} of ${position.total}` : ' '}
      </Text>
      <Text dimColor>{rule}</Text>
      <Box flexDirection="column">
        {tabs.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <Text
              key={tab.id}
              color={active ? colors.accent : undefined}
              bold={active}
              dimColor={!active}
            >
              {active ? '▸ ' : '  '}
              {tab.label}
            </Text>
          );
        })}
      </Box>
      <Text dimColor>{rule}</Text>
      <Text dimColor>{keyHints}</Text>
    </Box>
  );
}
