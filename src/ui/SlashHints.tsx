import { Box, Text } from 'ink';
import { useThemeColors } from './ThemeContext.js';
import { useDimensionsCtx } from './DimensionsContext.js';
import { MenuRow } from './overlays/MenuRow.js';
import { clampOffset, formatPosition, listPosition } from './overlays/viewer-util.js';
import {
  SLASH_PICKER_CHROME_COLUMNS,
  SLASH_ROW_SEPARATOR,
  padToWidth,
  slashPickerListRows,
  slashPickerTextWidth,
  splitSlashRowWidth,
  truncateToWidth,
  widthOf,
} from './slash-picker.js';
import { type SlashCommand } from './slash-commands.js';

// The catalogue itself lives in `slash-commands.js` — plain data, no Ink — and
// is re-exported here so importers that predate the split keep working.
export { SLASH_COMMANDS, matchSlashCommands, type SlashCommand } from './slash-commands.js';

interface SlashHintsProps {
  /** Filtered match list, computed by the caller so navigation state agrees. */
  matches: readonly SlashCommand[];
  /** Currently-highlighted index. Out-of-range values render nothing highlighted. */
  selectedIndex: number;
  /**
   * First match rendered. Owned by the caller for the same reason
   * {@link selectedIndex} is: the cursor and the window are one piece of state,
   * and `Prompt` already holds it through `useListWindow`.
   */
  offset: number;
  /**
   * Total terminal rows this popover may occupy, its own border and header
   * included. Computed by `Prompt` (`slashPickerMaxRows`) because only the
   * caller knows what dock the popover hangs off — the same contract as
   * `PlanPanel`'s prop of this name.
   *
   * Required, not defaulted: a default is the shape that lets a new call site
   * silently reintroduce the unbounded list this exists to bound.
   */
  maxRows: number;
}

/**
 * The slash-command picker: a bordered popover hanging under `<Prompt>` (#589).
 *
 * It used to be a bare `<Box marginLeft={2}>` of rows — no frame, no header and
 * **no height bound of any kind**, so a bare `/` rendered all 38 commands below
 * a prompt box that sits inside a fixed-height frame. See `slash-picker.ts` for
 * the budget and for why one command has to be exactly one row.
 *
 * Below the prompt box, never inside it: the rounded border there means "the
 * plan and the input are one container", and a completion list that moved
 * inside it would change what that box says. This is a dropdown hanging off it,
 * which is why it draws its own border rather than sharing one.
 *
 * The caller owns the cursor and the window so navigation state cannot disagree
 * with what is drawn — the same split `MenuOverlay` makes with `useListCursor` /
 * `useListWindow`, which is where `Prompt` gets both.
 */
export function SlashHints({ matches, selectedIndex, offset, maxRows }: SlashHintsProps) {
  const colors = useThemeColors();
  // The context, never `useStdout`: it is the one reactive source (SIGWINCH is
  // subscribed once at the top of the tree), and under the test renderer the
  // two disagree — no provider falls back to 80 columns while
  // ink-testing-library's stdout reports 100.
  const { columns } = useDimensionsCtx();
  if (matches.length === 0) return null;

  const size = Math.min(slashPickerListRows(maxRows), matches.length);
  // `clampOffset` rather than a hand-rolled `min`/`max` pair, and the same one
  // `useListWindow` applies on the way in, so the two cannot come to disagree
  // about what "keep the highlight visible" means. It is not redundant with the
  // caller's: `size` here is capped by the match count as well as by the row
  // budget, and these props are public — a caller holding a stale offset would
  // otherwise slice past the end and render an empty popover.
  const start = clampOffset(selectedIndex, offset, size, matches.length);
  const visible = matches.slice(start, start + size);

  const width = slashPickerTextWidth(columns);
  // One name cell for the whole popover, so the glosses line up into a column
  // instead of stepping in and out with each name's length. Measured over the
  // WHOLE match list rather than the visible slice, or the column would shift
  // as the window scrolls — and in display COLUMNS rather than UTF-16 units,
  // because a routine completion's text is the user's and may be CJK. See
  // `widthOf`: counting units let a row render at twice its budget and wrap,
  // which breaks the one-row-per-index invariant the window runs on.
  const nameWidth = matches.reduce((w, c) => Math.max(w, widthOf(c.name)), 0);
  const budget = splitSlashRowWidth(width, nameWidth);

  const position = listPosition(start, size, matches.length);

  return (
    <Box
      flexDirection="column"
      // Ink's `width` is the OUTER width, so the row budget has to be handed
      // back its own chrome or every maximal row wraps to two — and a wrapped
      // row breaks the "one command is one row" invariant the window runs on.
      width={width + SLASH_PICKER_CHROME_COLUMNS}
      borderStyle="round"
      borderColor={colors.muted}
      paddingX={1}
    >
      {/* Header and scroll position in one row, reserved unconditionally —
            `OverlayFooter`'s rule, so the popover's height never depends on the
            budget that decides what is hidden. `listPosition` returning `null`
            IS the suppression rule (no second `total <= size` test to drift
            from it); the row then states the bare noun rather than going blank,
            which is what lets it double as the title. No emoji glyph here or
            anywhere else in this box — see `glyph-width.ts`: Ink pads a
            bordered row against the larger figure, so one would render a column
            wider than its neighbours and wrap the border. */}
      <Text color={colors.muted}>{formatPosition(position, 'commands') ?? 'commands'}</Text>
      {visible.map((cmd, i) => (
        <MenuRow
          key={cmd.name}
          selected={start + i === selectedIndex}
          label={padToWidth(truncateToWidth(cmd.name, budget.name), budget.name)}
          trailing={
            budget.description > 0
              ? `${SLASH_ROW_SEPARATOR}${truncateToWidth(cmd.description, budget.description)}`
              : undefined
          }
        />
      ))}
    </Box>
  );
}
