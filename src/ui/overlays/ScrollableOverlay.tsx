import { useState, type ReactNode } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { getThemeColors } from '../../theme.js';

/** One pre-rendered visual row. `node` MUST occupy exactly one terminal line. */
export interface OverlayLine {
  key: string;
  node: ReactNode;
}

interface ScrollableOverlayProps {
  /** Bold accent heading shown at the top of the panel. */
  title: string;
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

// Rows reserved for the panel's own chrome: title + spacer + a one-row gap
// before the footer (held open by the flexGrow filler) + footer. The remaining
// terminal height is the scroll viewport.
const CHROME_ROWS = 4;

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
  title,
  lines,
  onClose = () => {},
  onCycleTab = () => {},
}: ScrollableOverlayProps) {
  const colors = getThemeColors();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const viewport = Math.max(1, rows - CHROME_ROWS);
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
    <Box flexDirection="column" height={rows}>
      <Text color={colors.accent} bold>
        {title}
      </Text>
      <Text> </Text>
      {visible.map((line) => (
        <Box key={line.key}>{line.node}</Box>
      ))}
      <Box flexGrow={1} />
      <Text dimColor>{footerHint(clamped, viewport, lines.length)}</Text>
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
