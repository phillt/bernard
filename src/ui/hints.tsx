import type { ReactNode } from 'react';
import { Text } from 'ink';
import { getThemeColors } from '../theme.js';

/**
 * The shared visual atoms for chrome legends — the bottom-left {@link HintBar},
 * the bottom-right `StatusBar` readouts, and the Shift+Tab viewer key legend
 * (`ViewerShell`). Routing all three through these components means a keystroke
 * hint / labeled stat reads identically wherever it appears: an accent lead
 * token, a muted rest, and the same dot divider — all in **theme** colors, not
 * the terminal's raw `dimColor` attribute (which ignores the active theme).
 */

/** An accent key/label + muted value pair — the atom of every chrome legend. */
export interface KeyHint {
  key: string;
  label: string;
}

/** The divider between chrome entries. Two spaces, a middle dot, two spaces. */
export const HINT_DIVIDER = '  ·  ';

/** The {@link HINT_DIVIDER} as a standalone node, for hand-built rows (StatusBar). */
export function HintDivider() {
  const colors = getThemeColors();
  return <Text color={colors.muted}>{HINT_DIVIDER}</Text>;
}

/**
 * One `key label` entry: the key in the theme accent, the label in the theme
 * muted. `label` accepts nodes so a caller can pass a composite value (e.g. a
 * token count followed by a gauge) — nested Text with its own color overrides
 * the muted default.
 */
export function HintEntry({ hintKey, label }: { hintKey: ReactNode; label: ReactNode }) {
  const colors = getThemeColors();
  return (
    <Text color={colors.muted}>
      <Text color={colors.accent}>{hintKey}</Text> {label}
    </Text>
  );
}

/**
 * A horizontal row of {@link KeyHint}s joined by the muted dot divider. Backs
 * both the bottom-left HintBar and the Shift+Tab viewer key legend.
 */
export function HintRow({ hints }: { hints: readonly KeyHint[] }) {
  return (
    <Text>
      {hints.map((h, i) => (
        <Text key={`${h.key}-${i}`}>
          {i > 0 ? <HintDivider /> : null}
          <HintEntry hintKey={h.key} label={h.label} />
        </Text>
      ))}
    </Text>
  );
}
