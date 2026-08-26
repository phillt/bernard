import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import { HintRow, HINT_CLOSE_ANY } from '../hints.js';
import { isAcknowledgeKey } from './overlay-contract.js';

interface HelpOverlayProps {
  onClose: () => void;
}

interface HelpRow {
  command: string;
  description: string;
}

const HELP_ROWS: HelpRow[] = [
  { command: '/help', description: 'Show this help' },
  { command: '/clear', description: 'Clear conversation (--save / -s to summarize first)' },
  { command: '/compact', description: 'Compress conversation history in-place' },
  { command: '/task', description: 'Run an isolated task (no history, structured output)' },
  { command: '/image', description: 'Attach an image: /image <path> [prompt]' },
  { command: '/memory', description: 'List persistent memories' },
  { command: '/scratch', description: 'List session scratch notes' },
  { command: '/mcp', description: 'List MCP servers and tools' },
  { command: '/cron', description: 'Show cron jobs and daemon status' },
  { command: '/facts', description: 'Show RAG facts in the current context window' },
  { command: '/lineup', description: 'Edit the active lineup (per-role × premium/mid/cheap)' },
  { command: '/lineups', description: 'List, switch, or create tier lineups' },
  { command: '/models', description: 'Browse the model catalog and add custom providers' },
  { command: '/refresh-models', description: 'Force-refresh the model catalog from the gateway' },
  { command: '/provider', description: 'Manage providers (alias of /models)' },
  { command: '/theme', description: 'Switch color theme' },
  { command: '/voice', description: 'Toggle text-to-speech readback and backend' },
  { command: '/routines', description: 'List saved routines' },
  { command: '/create-routine', description: 'Create a routine with guided AI assistance' },
  { command: '/create-task', description: 'Create a task routine with guided AI assistance' },
  { command: '/specialists', description: 'List specialist agents' },
  { command: '/create-specialist', description: 'Create a specialist with guided AI assistance' },
  { command: '/candidates', description: 'Review specialist suggestions' },
  {
    command: '/options',
    description: 'View and set options (max-tokens, max-steps, shell-timeout, token-window)',
  },
  {
    command: '/agent-options',
    description: 'Configure agent behavior (toggles, thresholds, saved assets)',
  },
  {
    command: '/tool-permissions',
    description: 'View/remove profile tool grants; toggle skip-permissions mode',
  },
  { command: '/profiles', description: 'Switch / create settings profiles' },
  { command: '/manage-profiles', description: 'Rename or delete saved profiles' },
  { command: '/update', description: 'Check for and install updates' },
  { command: '/exit', description: 'Quit Bernard' },
];

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
