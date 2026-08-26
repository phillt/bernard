import type { ReactNode } from 'react';
import { Text } from 'ink';
import { getThemeColors } from '../theme.js';
import { plural } from '../text.js';
import { windowBuffer } from './line-geometry.js';
import { LineWithCursor } from './use-line-editor.js';
import { useDimensionsCtx } from './DimensionsContext.js';

interface BoundedLineProps {
  buffer: string;
  cursor: number;
  showCursor: boolean;
  cursorColor: string;
  cursorGlyph?: string;
  /**
   * Columns of surrounding chrome to subtract from the terminal width —
   * borders, padding, and any {@link prefix}. Owned by the caller because only
   * it knows what box it sits in.
   */
  reserveColumns: number;
  /** Rendered inline before the buffer, inside the same `<Text>` flow. */
  prefix?: ReactNode;
}

/**
 * An editable line bounded on **both** axes (#354, #355).
 *
 * Shared by `Prompt` and `TextInputOverlay` because they share the editor: both
 * render a `useLineEditor` buffer, so both had the same unbounded growth. The
 * first pass fixed the vertical axis in `Prompt` only, which left the overlay
 * reaching 85 rows for an 8 000-character answer inside the same fixed-height
 * modal frame — the identical defect one component over. Reachable exactly
 * where it hurts, since `insert()` strips newlines for single-line editors, so
 * a pasted answer becomes one long soft-wrapped line.
 *
 * The bound cannot live in {@link LineWithCursor}: it returns a bare `<Text>`
 * consumed inside a `<Text>` flow, and the affordance rows have to be siblings
 * in a column `Box`. Both call sites already sit in one, so a sibling component
 * beside it works for both.
 */
export function BoundedLine({
  buffer,
  cursor,
  showCursor,
  cursorColor,
  cursorGlyph,
  reserveColumns,
  prefix,
}: BoundedLineProps) {
  const colors = getThemeColors();
  // Read from the context, not `useStdout` — under the test renderer these
  // disagree (context falls back to 80 columns, ink-testing-library's stdout
  // reports 100), and the context is the source every other component uses.
  const { columns, rows } = useDimensionsCtx();
  const width = Math.max(20, columns - reserveColumns);
  // A third of the frame, floored so a short terminal still shows something and
  // capped so a tall one doesn't hand the whole screen to the input.
  const maxRows = Math.max(3, Math.min(10, Math.floor(rows / 3)));
  const view = windowBuffer(buffer, cursor, width, maxRows);

  return (
    <>
      <MoreLines n={view.above} glyph="▲" color={colors.muted} />
      <Text>
        {prefix}
        <LineWithCursor
          buffer={view.text}
          cursor={view.cursor}
          showCursor={showCursor}
          cursorColor={cursorColor}
          cursorGlyph={cursorGlyph}
        />
      </Text>
      <MoreLines n={view.below} glyph="▼" color={colors.muted} />
    </>
  );
}

/** One component so the two affordances can't drift in wording. */
function MoreLines({ n, glyph, color }: { n: number; glyph: string; color: string }) {
  if (n <= 0) return null;
  return <Text color={color}>{`${glyph} ${n} more ${plural(n, 'line', 'lines')}`}</Text>;
}

/** Exported for the Box-less callers that need the same chrome budget. */
export const PROMPT_RESERVED_COLUMNS = 10;
export const OVERLAY_RESERVED_COLUMNS = 4;
