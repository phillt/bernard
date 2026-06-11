import { useState } from 'react';
import { Box, useInput, useStdout } from 'ink';
import {
  ViewerShell,
  viewerViewport,
  type OverlayLine,
  type OverlayTab,
} from './ViewerShell.js';

export type { OverlayLine, OverlayTab } from './ViewerShell.js';

interface ScrollableOverlayProps {
  tabs: readonly OverlayTab[];
  activeTab: string;
  /**
   * Flat list of visual rows. Each entry must render to exactly one terminal
   * line — the windowing math counts entries, not wrapped height, so a node
   * that wraps to two lines would desync the scroll position. Callers
   * width-clamp their text (via `truncate`) to keep this invariant.
   */
  lines: OverlayLine[];
  onClose?: () => void;
  onCycleTab?: () => void;
}

/**
 * A plain vertically-scrollable list rendered inside the shared `ViewerShell`
 * (used by `StatusViewer`). Owns only the scroll keystream — `↑/↓`/`j`/`k`,
 * `PgUp`/`PgDn`, `g`/`G`; Esc and Shift-Tab belong to the shell.
 */
export function ScrollableOverlay({
  tabs,
  activeTab,
  lines,
  onClose,
  onCycleTab,
}: ScrollableOverlayProps) {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const viewport = viewerViewport(rows, { tabCount: tabs.length });
  const maxOffset = Math.max(0, lines.length - viewport);

  const [offset, setOffset] = useState(0);
  // Clamp on every render so a resize (smaller viewport) can't strand the
  // window past the end; movement is computed from `clamped`, never stale state.
  const clamped = Math.min(offset, maxOffset);

  useInput((input, key) => {
    if (key.downArrow || input === 'j') {
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
  const position =
    lines.length > viewport
      ? { first: clamped + 1, last: Math.min(lines.length, clamped + viewport), total: lines.length }
      : null;

  return (
    <ViewerShell
      tabs={tabs}
      activeTab={activeTab}
      position={position}
      keyHints="↑/↓ scroll · ⇧⇥ switch tab · esc close"
      onClose={onClose}
      onCycleTab={onCycleTab}
    >
      {visible.map((line) => (
        <Box key={line.key}>{line.node}</Box>
      ))}
    </ViewerShell>
  );
}
