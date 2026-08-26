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

/**
 * The shared hint vocabulary (#266).
 *
 * One spelling per key, because five coexisted: `Esc`/`esc`, `Enter`/`↵`,
 * `shift+tab`/`⇧⇥`, and `cancel`/`back`/`close` for the same physical key.
 * Lowercase glyph style wins because seven of the eight surfaces already
 * rendering through `HintRow` used it — the odd one out was `TextInputOverlay`,
 * which is converted here.
 */
export const KEY = {
  esc: 'esc',
  enter: '↵',
  shiftTab: '⇧⇥',
  space: 'space',
  arrows: '↑/↓',
  arrowsAll: '←/→/↑/↓',
  leftRight: '←/→',
  pageKeys: '⇞⇟',
  /** Drilled-in viewers spend Esc on "back one level", so they advertise both. */
  escBack: 'esc/←',
} as const;

/** `esc close` — the dismiss hint for a read-only surface. */
export const HINT_CLOSE: KeyHint = { key: KEY.esc, label: 'close' };
/**
 * `↵/esc/q close` — one entry for a surface where all three do the same thing.
 * Three separate rows each saying "close" is noise, and the compound-key idiom
 * is already how this codebase spells `↑/↓` and `←/→/↑/↓`.
 */
export const HINT_CLOSE_ANY: KeyHint = { key: `${KEY.enter}/${KEY.esc}/q`, label: 'close' };
/** `esc cancel` — the dismiss hint for a surface that commits something. */
export const HINT_CANCEL: KeyHint = { key: KEY.esc, label: 'cancel' };
/** `⇧⇥ switch tab` — the viewer tab-cycle hint. */
export const HINT_SWITCH_TAB: KeyHint = { key: KEY.shiftTab, label: 'switch tab' };
/** `↑/↓ move` — selection movement, as distinct from `scroll`. */
export const HINT_MOVE: KeyHint = { key: KEY.arrows, label: 'move' };
/** `↑/↓ scroll` — viewport movement, as distinct from `move`. */
export const HINT_SCROLL: KeyHint = { key: KEY.arrows, label: 'scroll' };
/** `↵ select` — commit the highlighted row. */
export const HINT_SELECT: KeyHint = { key: KEY.enter, label: 'select' };
/** `esc/← back` — leave one drill level, as distinct from closing the viewer. */
export const HINT_BACK: KeyHint = { key: KEY.escBack, label: 'back' };
/** `esc/← back to list` — the same move, named for the panel it returns to. */
export const HINT_BACK_TO_LIST: KeyHint = { key: KEY.escBack, label: 'back to list' };
