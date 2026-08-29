import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import { HintRow, HINT_CLOSE_ANY } from '../hints.js';
import { isAcknowledgeKey } from './overlay-contract.js';
import { SLASH_COMMANDS } from '../SlashHints.js';

interface HelpOverlayProps {
  onClose: () => void;
}

interface HelpRow {
  command: string;
  description: string;
}

/**
 * The `Commands` section, derived from the one slash-command catalogue rather
 * than retyped here (#390). This used to be a hand-maintained second table
 * whose only sync mechanism was a comment in `SlashHints.tsx` asking the reader
 * to keep them aligned — by the time it was fixed it had lost `/rag`, `/policy`
 * and `/usage` and disagreed with the strip on four descriptions.
 *
 * The field rename (`name` → `command`) is a one-line bridge on purpose:
 * `HelpRow` is the row shape this file's renderer takes, and `EDITING_ROWS`
 * below reuses it for keyboard chords that are not slash commands at all — so
 * renaming either side to make the shapes line up would have coupled the chord
 * table to the command catalogue for no gain.
 *
 * `detail ?? description` is the width budget: the hint strip sits beside the
 * prompt and the help screen owns a full frame, so the few commands that read
 * better long say so via `detail` (see `SlashCommand`).
 */
const HELP_ROWS: readonly HelpRow[] = SLASH_COMMANDS.map((cmd) => ({
  command: cmd.name,
  description: cmd.detail ?? cmd.description,
}));

/**
 * The line-editor chords (#356), which work in the prompt and in every overlay
 * text field. Listed here because they appeared in no hint surface at all —
 * `HintBar` has no room and the footer legends cover only the active overlay's
 * own keys, so an editing chord was undiscoverable short of reading the source.
 *
 * `Home`/`End` are deliberately absent: Ink surfaces both of their encodings as
 * empty input with no key flags, so they cannot be bound through `useInput` at
 * all (see #356). `Ctrl-A`/`Ctrl-E` stand in, and are line-wise rather than
 * buffer-wise.
 */
const EDITING_ROWS: readonly HelpRow[] = [
  { command: '⌥←  ⌥→', description: 'Move by word (also ⌃← / ⌃→, or ⌥B / ⌥F)' },
  { command: '⌃A  ⌃E', description: 'Start / end of the current line' },
  { command: '⌃W', description: 'Delete the word before the cursor (also ⌥⌫)' },
  { command: '⌃U  ⌃K', description: 'Delete to start / end of the line' },
  { command: '⌃D', description: 'Delete the character at the cursor' },
  { command: '⇧↵', description: 'Insert a newline without submitting (also ⌃J)' },
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
 * Read-only help screen rendered as an overlay. Replaces the legacy
 * `printHelp()` stdout dump. Esc / Enter / q close it; Shift-Tab cycling
 * still works because the active overlay = 'help' is treated like the
 * other viewer overlays (status, sources).
 */
export function HelpOverlay({ onClose }: HelpOverlayProps) {
  const colors = getThemeColors();
  useInput((input, key) => {
    if (isAcknowledgeKey(input, key)) onClose();
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      {SECTIONS.map((section) => (
        <Box key={section.title} flexDirection="column">
          <Text color={colors.accent} bold>
            {section.title}
          </Text>
          <Text> </Text>
          {section.rows.map((row) => (
            <Box key={row.command}>
              <Box width={20}>
                <Text color={colors.accent}>{row.command}</Text>
              </Box>
              <Text color={colors.muted}>— {row.description}</Text>
            </Box>
          ))}
          <Text> </Text>
        </Box>
      ))}
      <HintRow hints={[HINT_CLOSE_ANY]} />
    </Box>
  );
}
