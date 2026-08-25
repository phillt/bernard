import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { getThemeColors } from '../../theme.js';

/**
 * The single selection marker for every menu / list / confirm / grid highlight
 * in the UI. Change this (and the styling in {@link MenuRow}) to restyle every
 * selectable surface at once — the whole point of routing them through one
 * component instead of the four hand-rolled copies that had already drifted
 * (`MenuList`, `ConfirmDialog`, `ModelGridOverlay`, `SlashHints`).
 */
export const MENU_MARKER = '> ';
const MENU_MARKER_BLANK = '  ';

interface MenuRowProps {
  /** Whether this row is the cursor target — drives the marker + emphasis. */
  selected: boolean;
  /** Primary label content (string or nodes). */
  label: ReactNode;
  /**
   * Dim content rendered after the label on the same line — e.g. the slash-hint
   * `— description` tail that should stay muted regardless of selection.
   */
  trailing?: ReactNode;
  /** Fixed cell width for grid layouts (`ModelGridOverlay`). */
  width?: number;
  /**
   * Render the label in the theme **muted** color when **not** selected (used by
   * the horizontal tab strip, where inactive tabs read as muted). Off by default
   * so ordinary menu rows keep the default foreground when unhighlighted.
   */
  dimUnselected?: boolean;
}

/**
 * One selectable row: an accent marker (or blank gutter) followed by the label,
 * which goes bold + accent when selected. The shared visual atom behind every
 * menu, confirm dialog, model-grid cell, slash-hint, and viewer tab.
 */
export function MenuRow({ selected, label, trailing, width, dimUnselected }: MenuRowProps) {
  const colors = getThemeColors();
  return (
    <Box width={width}>
      <Text color={colors.accent}>{selected ? MENU_MARKER : MENU_MARKER_BLANK}</Text>
      <Text
        bold={selected}
        color={selected ? colors.accent : dimUnselected ? colors.muted : undefined}
      >
        {label}
      </Text>
      {/* Themed muted, never Ink's raw `dimColor` — that attribute ignores the
          active theme, which is exactly what the high-contrast and colorblind
          themes exist to override (#320). The label above already does this. */}
      {trailing != null && <Text color={colors.muted}>{trailing}</Text>}
    </Box>
  );
}
