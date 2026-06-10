import { useState, type ReactNode } from 'react';
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

interface ScrollableOverlayProps {
  /** All viewer tabs, rendered as a vertical menu pinned to the bottom. */
  tabs: readonly OverlayTab[];
  /** `id` of the tab this panel is — highlighted in the menu; the rest are muted. */
  activeTab: string;
  /**
   * Flat list of visual rows. Each entry must render to exactly one terminal
   * line — the windowing math counts entries, not wrapped height, so a node
   * that wraps to two lines would desync the scroll position. Callers
   * width-clamp their text (via `truncate`) to keep this invariant.
   */
  lines: OverlayLine[];
  /** Close the panel (Esc). Defaults to a no-op for standalone rendering/tests. */
  onClose?: () => void;
  /** Advance to the next Shift-Tab tab (Shift-Tab). Defaults to a no-op. */
  onCycleTab?: () => void;
}

// Rows reserved below the scroll viewport: one menu row per tab, a one-row gap
// above the menu (held open by the flexGrow filler), and the footer hint.
const FOOTER_AND_GAP_ROWS = 2;

/**
 * Full-screen scrollable panel shared by the Shift-Tab viewer tabs
 * (`StatusViewer`, `SourcesViewer`). Owns its own keystream while mounted —
 * `<App>` deactivates its top-level `useInput` for viewer overlays (like it
 * already does for modal overlays), so Esc / Shift-Tab are handled here and
 * forwarded back via `onClose` / `onCycleTab`.
 *
 * The outer Box is pinned to the full terminal height so the live frame fills
 * the screen and pushes prior `<Static>` scrollback up — the panel reads as a
 * replacement for the thread, not an addition below it. Closing it collapses
 * the frame back to the prompt without remounting `<Thread>` (which would
 * reprint scrollback — see `src/ui/Thread.tsx`).
 */
export function ScrollableOverlay({
  tabs,
  activeTab,
  lines,
  onClose = () => {},
  onCycleTab = () => {},
}: ScrollableOverlayProps) {
  const colors = getThemeColors();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  // Never occupy the LAST terminal row. A dynamic (non-Static) Ink frame that
  // fills the full height can't be erased cleanly — the final newline scrolls
  // the terminal and desyncs Ink's cursor math, so the next render (e.g. after
  // Esc closes the overlay) leaves stale rows on screen until something forces
  // a repaint. Capping at rows-1 keeps the erase correct.
  const frameHeight = Math.max(1, rows - 1);
  const viewport = Math.max(1, frameHeight - tabs.length - FOOTER_AND_GAP_ROWS);
  const maxOffset = Math.max(0, lines.length - viewport);

  const [offset, setOffset] = useState(0);
  // The true window start: clamp on every render so a terminal resize (smaller
  // viewport) or a shorter tab can't strand the window past the end. Movement
  // is computed from `clamped`, not the raw state, so a stale-high `offset`
  // can never linger.
  const clamped = Math.min(offset, maxOffset);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
    } else if (key.shift && key.tab) {
      onCycleTab();
    } else if (key.downArrow || input === 'j') {
      setOffset(Math.min(maxOffset, clamped + 1));
    } else if (key.upArrow || input === 'k') {
      setOffset(Math.max(0, clamped - 1));
    } else if (key.pageDown) {
      setOffset(Math.min(maxOffset, clamped + viewport));
    } else if (key.pageUp) {
      setOffset(Math.max(0, clamped - viewport));
    } else if (input === 'g') {
      setOffset(0);
    } else if (input === 'G') {
      setOffset(maxOffset);
    }
  });

  const visible = lines.slice(clamped, clamped + viewport);

  return (
    <Box flexDirection="column" height={frameHeight}>
      {visible.map((line) => (
        <Box key={line.key}>{line.node}</Box>
      ))}
      <Box flexGrow={1} />
      <TabMenu tabs={tabs} activeTab={activeTab} accent={colors.accent} />
      <Text dimColor>{footerHint(clamped, viewport, lines.length)}</Text>
    </Box>
  );
}

/**
 * Vertical tab menu pinned to the bottom. The active tab is highlighted (accent
 * + bold, `▸` marker); the rest are muted. Marker + label share one `<Text>` so
 * the active row reads as a single contiguous `▸ <label>` string.
 */
function TabMenu({
  tabs,
  activeTab,
  accent,
}: {
  tabs: readonly OverlayTab[];
  activeTab: string;
  accent: string;
}) {
  return (
    <Box flexDirection="column">
      {tabs.map((tab) => {
        const active = tab.id === activeTab;
        return (
          <Text key={tab.id} color={active ? accent : undefined} bold={active} dimColor={!active}>
            {active ? '▸ ' : '  '}
            {tab.label}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * Footer: a `rows X–Y of N` position indicator (only when the content actually
 * overflows) plus the key legend. 1-based, inclusive range over the visible
 * window.
 */
function footerHint(offset: number, viewport: number, total: number): string {
  const base = 'Esc to close · Shift-Tab to switch tabs';
  if (total <= viewport) return base;
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(total, offset + viewport);
  return `rows ${first}–${last} of ${total} · ↑/↓ scroll · ${base}`;
}
