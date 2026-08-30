import { Text } from 'ink';
import { getThemeColors } from '../../theme.js';
import { HintRow, type KeyHint } from '../hints.js';

/**
 * Terminal rows {@link OverlayFooter} occupies. Exported so a windowed
 * overlay's chrome budget subtracts the same number the component renders —
 * the two used to sit three files apart and agree by hand, which is how
 * "always reserve the row" silently becomes false in one of them.
 */
export const OVERLAY_FOOTER_ROWS = 3;

interface OverlayFooterProps {
  /** `items 3–9 of 40`, or null when everything fits. */
  position: string | null;
  hints: KeyHint[];
}

/**
 * The blank / position / hints trio that closes a free-standing overlay —
 * `MenuOverlay` and `ModelGridOverlay`, which are NOT inside `ViewerShell` and
 * so cannot use its chrome.
 *
 * The position row is ALWAYS reserved — blank when everything fits, as
 * `ViewerShell` does with a null position. Rendering it conditionally would
 * make the layout height depend on the very budget it feeds, so the last row
 * would flicker in and out as the list crossed the threshold.
 *
 * `colors.muted`, never Ink's `dimColor`, which ignores the active theme
 * (pinned by `overlay-footers.theme.test.tsx`).
 */
export function OverlayFooter({ position, hints }: OverlayFooterProps) {
  const colors = getThemeColors();
  return (
    <>
      <Text> </Text>
      <Text color={colors.muted}>{position ?? ' '}</Text>
      <HintRow hints={hints} />
    </>
  );
}
