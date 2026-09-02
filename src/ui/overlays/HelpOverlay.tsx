import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import { HINT_CLOSE_ANY, HINT_SCROLL } from '../hints.js';
import { isAcknowledgeKey } from './overlay-contract.js';
import { SLASH_COMMANDS } from '../slash-commands.js';
import { useDimensionsCtx } from '../DimensionsContext.js';
import { overlayViewport } from './menu-geometry.js';
import { clamp, formatPosition, listPosition, navDelta } from './viewer-util.js';
import { OverlayFooter, OVERLAY_FOOTER_ROWS } from './OverlayFooter.js';
import { truncate } from '../../text.js';

interface HelpOverlayProps {
  onClose: () => void;
  /**
   * Rows the caller has already spent above this overlay — the alert banner.
   * Same contract as `MenuOverlay` / `ModelGridOverlay`: only `<App>` knows what
   * else is on screen, and the banner can appear *while* an overlay is open, so
   * the budget is derived every render rather than fixed at mount.
   */
  reserveRows?: number;
}

interface HelpRow {
  command: string;
  description: string;
}

/**
 * The `Commands` section, derived from the one slash-command catalogue rather
 * than retyped here (#390). This was a hand-maintained second copy of it; see
 * `SLASH_COMMANDS` for what that cost and `SlashCommand.detail` for the
 * fallback below.
 *
 * The field rename (`name` → `command`) is a one-line bridge on purpose:
 * `HelpRow` is the row shape this file's renderer takes, and `EDITING_ROWS`
 * below reuses it for keyboard chords that are not slash commands at all — so
 * renaming either side to make the shapes line up would have coupled the chord
 * table to the command catalogue for no gain.
 */
const HELP_ROWS: readonly HelpRow[] = SLASH_COMMANDS.map((cmd) => ({
  command: cmd.name,
  description: cmd.detail ?? cmd.description,
}));

/**
 * The line-editor chords (#356). Every row except `⇧↵` is consumed by
 * `useLineEditor.handleKey`, so those work in the prompt **and** in every
 * overlay text field — both build on the same editor. `⇧↵` is the exception
 * and is labelled as such: it never reaches `handleKey` at all. It is
 * recognised by `Prompt.tsx`'s own `newlineIntent`, which calls
 * `editor.insert('\n')` directly, and `TextInputOverlay` constructs its editor
 * with no options — so `multiline: false`, and `insert()` strips newlines.
 * Advertising it as universal was therefore a claim that is false in exactly
 * the place a user would try it (#361); `TextInputOverlay.test.tsx`'s
 * "newline-ish keys are stripped" pins the stripping half.
 *
 * Listed here because these chords appeared in no hint surface at all —
 * `HintBar` has no room and the footer legends cover only the active overlay's
 * own keys, so an editing chord was undiscoverable short of reading the source.
 *
 * `Home`/`End` are deliberately absent: Ink surfaces both of their encodings as
 * empty input with no key flags, so they cannot be bound through `useInput` at
 * all (see #356). `Ctrl-A`/`Ctrl-E` stand in, and are line-wise rather than
 * buffer-wise.
 *
 * Exported so `HelpOverlay.test.tsx` pins the ADVERTISED list against what the
 * editor actually consumes, rather than retyping it — the anti-drift move #390
 * made for `SLASH_COMMANDS`. A rendered frame cannot make that assertion:
 * "inert" and "swallowed" look identical in one.
 *
 * The boolean alone is not sufficient either, which is why that test asserts
 * editor STATE beside it. Ink hands `⌃J` to `useInput` as a bare `\n` and
 * ESC+CR as a bare `\r`, both with no key flags at all, so `handleKey` takes
 * them as printable input and reports `true` — after `insert()` has stripped
 * the newline and changed nothing. Measured, not assumed. The kitty/ghostty
 * CSI-u spelling is worse than inert in a text field: Ink strips only the ESC,
 * so `handleKey` inserts the literal `[13;2u`. That one is a defect in the
 * editor rather than in this screen and is left where it is; what belongs here
 * is not telling the user the chord works where it does not.
 */
export const EDITING_ROWS: readonly HelpRow[] = [
  // `⌃B`/`⌃F` move by WORD here, not by character as in stock readline:
  // `use-line-editor.tsx` tests `wordMod = key.meta || key.ctrl` ahead of the
  // plain arrows, so the ctrl spelling lands in the same branch as `⌥B`/`⌥F`.
  { command: '⌥←  ⌥→', description: 'Move by word (also ⌃← / ⌃→, ⌥B / ⌥F, or ⌃B / ⌃F)' },
  { command: '⌃A  ⌃E', description: 'Start / end of the current line' },
  { command: '⌃W', description: 'Delete the word before the cursor (also ⌥⌫)' },
  { command: '⌃U  ⌃K', description: 'Delete to start / end of the line' },
  { command: '⌃D', description: 'Delete the character at the cursor' },
  { command: '⇧↵', description: 'Insert a newline without submitting — prompt only (also ⌃J)' },
];

/**
 * One table, one renderer. The two lists were separate `.map()` blocks with
 * byte-identical bodies — which had already cost something inside this change:
 * the `dimColor` → theme-colour fix had to be typed twice.
 */
const SECTIONS: readonly { title: string; rows: readonly HelpRow[] }[] = [
  { title: 'Commands', rows: HELP_ROWS },
  { title: 'Editing', rows: EDITING_ROWS },
];

/**
 * One rendered row of the help screen, section headers and spacers included.
 *
 * Flattening the two-level `SECTIONS` shape into a list is what makes the
 * screen windowable: `clamp` / `listPosition` count entries, so a header or a
 * blank has to BE an entry rather than a nested render that the arithmetic
 * cannot see. It is also what lets the catalogue assertion in
 * `HelpOverlay.test.tsx` run with no renderer and no terminal size at all —
 * the `line-geometry.ts` doctrine.
 */
export type HelpLine =
  | { kind: 'section'; title: string }
  | { kind: 'blank' }
  | { kind: 'command'; command: string; description: string };

function buildHelpLines(): HelpLine[] {
  const lines: HelpLine[] = [];
  for (const section of SECTIONS) {
    lines.push({ kind: 'section', title: section.title });
    lines.push({ kind: 'blank' });
    for (const row of section.rows) lines.push({ kind: 'command', ...row });
    lines.push({ kind: 'blank' });
  }
  return lines;
}

// Built once, not per render: the catalogue is static and the array is never
// mutated, so rebuilding 46 objects on every scroll keystroke would be waste in
// the one place a help screen is interactive.
const HELP_LINES: readonly HelpLine[] = buildHelpLines();

/** The exact row sequence {@link HelpOverlay} renders, in order. */
export function helpLines(): readonly HelpLine[] {
  return HELP_LINES;
}

/** Width of the left gutter holding the command / chord. */
const COMMAND_COLUMN = 20;
/** Separator between the gutter and the description. */
const DESCRIPTION_LEAD = '— ';
/** App wraps every overlay in `paddingX={2}`. */
const APP_PADDING_COLUMNS = 4;

/**
 * How much room a description gets before it has to be cut.
 *
 * **Every row must occupy exactly one terminal line.** That is the same
 * invariant `ScrollableOverlay` documents on its `lines` prop, and for the same
 * reason: the windowing counts entries, not wrapped height, so one row that
 * soft-wraps desyncs the scroll position from the frame. Help violated it —
 * `/options`' 73-character `detail` against a 20-column gutter needs ~95
 * columns, so on an ordinary 80-column terminal several rows silently became
 * two.
 */
function descriptionWidth(usableColumns: number): number {
  return Math.max(1, usableColumns - COMMAND_COLUMN - DESCRIPTION_LEAD.length);
}

/**
 * Read-only help screen rendered as an overlay, replacing a legacy stdout dump
 * that #390 finally deleted — it had outlived its last caller and gone stale by
 * ten commands. Esc / Enter / q close it; ↑/↓ (j/k), PgUp/PgDn and g/G scroll.
 *
 * **Bounded to the frame (#392).** It used to render every row unconditionally:
 * 34 commands + 6 chords + headers + spacers = 46 rows, before wrapping, into
 * the 23 `viewerFrameHeight(24)` allows. Roughly twice the frame, so rows
 * overwrote each other and the terminal came back garbled (`/themeder`,
 * `/optionstes`). Both halves of that had to be fixed: the vertical overflow
 * via the window below, and the horizontal one via {@link descriptionWidth},
 * since a wrapped row would put the count back off by one per long description.
 *
 * **It stays a modal and deliberately does NOT adopt `ScrollableOverlay`**,
 * whose scroll keystream is otherwise exactly this one. That component renders
 * inside `ViewerShell`, which requires `tabs` + `activeTab` (neither optional)
 * and binds neither `Enter` nor `q` — so adopting it would demote help from a
 * modal to a Shift+Tab viewer tab and drop two of its three close keys. The
 * distinction is real, not incidental: the Shift+Tab cycle is live *session
 * inspection* (status, sources, context, usage), and help is static
 * documentation that has nothing per-session to show.
 *
 * Consistent with that, Shift+Tab does **not** cycle while help is open: App's
 * Shift+Tab handler is gated on `activeOverlay === null`. The doc comment here
 * used to claim it did. What #392 actually changed on App's side is one line —
 * `'help'` joining the `viewerActive` chain — so that in legacy (non-full-
 * screen) mode help REPLACES the prompt chrome instead of rendering below it,
 * which was adding five more rows to a surface already twice too tall.
 */
export function HelpOverlay({ onClose, reserveRows = 0 }: HelpOverlayProps) {
  const colors = getThemeColors();
  // Terminal size comes from the context, never `useStdout`: the context is the
  // one reactive source (it subscribes to SIGWINCH once at the top of the tree),
  // and under the test renderer the two disagree — no provider falls back to 80
  // columns while ink-testing-library's stdout reports 100.
  const { columns: termColumns, rows: termRows } = useDimensionsCtx();
  const lines = helpLines();

  // Chrome is a constant here, unlike `MenuOverlay` / `ModelGridOverlay`, which
  // measure theirs with `chromeRows`: help renders no title, header block or
  // footnote ABOVE the list, so nothing up there can soft-wrap. (The footer's
  // own strings can, on a very narrow terminal, against a flat
  // `OVERLAY_FOOTER_ROWS` — that is the same bet both sibling overlays take, so
  // it stays consistent rather than being solved here alone.)
  //
  // `reserveRows` is what the caller subtracts for rows this overlay never
  // sees: the alert banner, which renders ABOVE the overlay zone in both the
  // full-screen and legacy branches and can appear while help is open. Help
  // also joins `viewerActive`, which handles the legacy prompt chrome — the two
  // cover different rows and both are needed.
  const chrome = 1 /* the marginTop below */ + OVERLAY_FOOTER_ROWS + reserveRows;
  const viewport = overlayViewport(termRows, chrome);
  const maxOffset = Math.max(0, lines.length - viewport);

  // A plain scroll offset, NOT `useListWindow`. That hook exists to keep a
  // CURSOR on screen and only moves the window once the cursor would leave it —
  // correct for a menu, wrong here, where there is no highlight to follow and
  // the first `viewport` presses of ↓ would move nothing visible at all. This
  // is `ScrollableOverlay`'s shape instead, which is the house pattern for a
  // cursor-less document. Clamped at RENDER as well as in the setter, so a
  // resize that shrinks the viewport cannot strand the window past the end.
  const [scroll, setScroll] = useState(0);
  const offset = clamp(scroll, 0, maxOffset);

  useInput((input, key) => {
    // Dismissal is decided first, ahead of the scroll keystream — the ordering
    // every overlay obeys (#266). The two key sets happen not to overlap today
    // (`navDelta` claims j/k/g/G and the arrows; `isAcknowledgeKey` claims Esc,
    // Enter and `q`), so this is convention rather than a live necessity — but
    // it is the convention that keeps a future movement key from silently
    // shadowing a dismiss key, which is why it is not left to chance.
    if (isAcknowledgeKey(input, key)) {
      onClose();
      return;
    }
    const delta = navDelta(input, key, viewport, lines.length);
    // A FUNCTIONAL updater, not `offset + delta` — the same rule `useListCursor`
    // documents, and it bit here before the test caught it. Ink can deliver a
    // burst of keystrokes inside one React batch, and reading the render
    // closure's `offset` collapses the whole burst into a single line of
    // movement. The inner clamp re-applies the render rule to `prev`, which is
    // the raw stored value and may be stale-out-of-range after a resize.
    if (delta !== null) {
      setScroll((prev) => clamp(clamp(prev, 0, maxOffset) + delta, 0, maxOffset));
    }
  });

  const usableColumns = termColumns - APP_PADDING_COLUMNS;
  const descWidth = descriptionWidth(usableColumns);
  const visible = lines.slice(offset, offset + viewport);
  const pos = listPosition(offset, viewport, lines.length);
  const position = formatPosition(pos, 'lines');

  return (
    <Box flexDirection="column" marginTop={1}>
      {visible.map((line, idx) => {
        const key = `l-${offset + idx}`;
        if (line.kind === 'blank') return <Text key={key}> </Text>;
        if (line.kind === 'section') {
          return (
            <Text key={key} color={colors.accent} bold>
              {line.title}
            </Text>
          );
        }
        return (
          <Box key={key}>
            <Box width={COMMAND_COLUMN}>
              <Text color={colors.accent} wrap="truncate">
                {line.command}
              </Text>
            </Box>
            <Text color={colors.muted}>
              {DESCRIPTION_LEAD}
              {truncate(line.description, descWidth)}
            </Text>
          </Box>
        );
      })}
      <OverlayFooter position={position} hints={[HINT_SCROLL, HINT_CLOSE_ANY]} />
    </Box>
  );
}
