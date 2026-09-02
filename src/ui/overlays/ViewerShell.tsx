import type { ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import { MenuRow } from './MenuRow.js';
import { HintRow, type KeyHint } from '../hints.js';
import { getThemeColors } from '../../theme.js';
import { useDimensionsCtx } from '../DimensionsContext.js';

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
 * The frame/viewport arithmetic now lives in `viewer-util.ts` (#266) — pure
 * geometry that `menu-geometry.ts` builds on, and that must not pull React and
 * Ink into a test suite needing neither (the `line-geometry.ts` doctrine).
 * Re-exported here so the three existing importers keep their import path.
 */
export { viewerFrameHeight, viewerViewport } from './viewer-util.js';
import { formatPosition } from './viewer-util.js';

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
   *
   * With it `false` the shell claims no key that unconditionally leaves —
   * Ctrl-C quits Bernard rather than closing an overlay (#360) — so getting out
   * of a drilled-in viewer is a level-by-level walk of repeated Esc.
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

  useInput((_input, key) => {
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
      <Text color={colors.muted}>{formatPosition(position, 'rows') ?? ' '}</Text>
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
