import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';

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
  { command: '/provider', description: 'Switch LLM provider' },
  { command: '/model', description: 'Switch model for current provider' },
  { command: '/theme', description: 'Switch color theme' },
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
  { command: '/profiles', description: 'Switch / create settings profiles' },
  { command: '/manage-profiles', description: 'Rename or delete saved profiles' },
  { command: '/update', description: 'Check for and install updates' },
  { command: '/exit', description: 'Quit Bernard' },
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
    if (key.escape || key.return || input === 'q') onClose();
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent} bold>
        Commands
      </Text>
      <Text> </Text>
      {HELP_ROWS.map((row) => (
        <Box key={row.command}>
          <Box width={20}>
            <Text color={colors.accent}>{row.command}</Text>
          </Box>
          <Text dimColor>— {row.description}</Text>
        </Box>
      ))}
      <Text> </Text>
      <Text dimColor>Enter / Esc / q to close</Text>
    </Box>
  );
}
