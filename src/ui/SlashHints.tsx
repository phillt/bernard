import { Box, Text } from 'ink';
import { getThemeColors } from '../theme.js';

export interface SlashCommand {
  name: string;
  description: string;
}

/**
 * The static set of slash commands the Ink shell will ship at cutover.
 *
 * Phase B intentionally lists only the commands `<App>` wires through in this
 * milestone (`/exit`, `/clear`, `/profiles`). Phase D ports the remaining
 * commands from `src/repl.ts` (`/agent-options`, `/manage-profiles`, `/cron`,
 * `/image`, `/run-routine`, etc.) when the bespoke layer is deleted and adds
 * their entries here.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/exit', description: 'Exit Bernard' },
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/profiles', description: 'Switch settings profile' },
];

interface SlashHintsProps {
  /** Current input buffer; hints render only when this starts with `/`. */
  buffer: string;
}

/**
 * Renders a small list of slash-command suggestions filtered by the current
 * input buffer. Mounted as a child of `<Prompt>` so it sits directly above
 * the input line — same UX as the legacy `redrawWithHints` path it replaces.
 */
export function SlashHints({ buffer }: SlashHintsProps) {
  const colors = getThemeColors();
  if (!buffer.startsWith('/')) return null;
  const query = buffer.slice(1).toLowerCase();
  const matches = SLASH_COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(query));
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {matches.map((cmd) => (
        <Box key={cmd.name}>
          <Text color={colors.accent} bold>
            {cmd.name}
          </Text>
          <Text dimColor> — {cmd.description}</Text>
        </Box>
      ))}
    </Box>
  );
}
