import { Box, Text } from 'ink';
import { getThemeColors } from '../theme.js';

export interface SlashCommand {
  name: string;
  description: string;
}

/**
 * Canonical slash-command catalogue surfaced to the autocomplete hint strip.
 * Mirrors the rows rendered by `<HelpOverlay>` and every branch handled by
 * `<App>.handleSubmit` — keep these in sync when adding a command. Items the
 * user can't dispatch directly from the prompt (e.g. variants with required
 * args) belong in the help screen, not here.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/help', description: 'Show command list' },
  { name: '/clear', description: 'Clear conversation (--save / -s to summarize first)' },
  { name: '/compact', description: 'Compress conversation history in-place' },
  { name: '/task', description: 'Run an isolated task (no history, structured output)' },
  { name: '/image', description: 'Attach an image: /image <path> [prompt]' },
  { name: '/memory', description: 'List persistent memories' },
  { name: '/scratch', description: 'List session scratch notes' },
  { name: '/mcp', description: 'List MCP servers and tools' },
  { name: '/cron', description: 'Show cron jobs and daemon status' },
  { name: '/rag', description: 'Toggle / inspect the RAG store' },
  { name: '/facts', description: 'Show RAG facts in the current context window' },
  { name: '/policy', description: 'Show last policy decision' },
  { name: '/provider', description: 'Switch LLM provider' },
  { name: '/model', description: 'Switch model for current provider' },
  { name: '/theme', description: 'Switch color theme' },
  { name: '/routines', description: 'List saved routines' },
  { name: '/create-routine', description: 'Create a routine with guided AI assistance' },
  { name: '/create-task', description: 'Create a task routine with guided AI assistance' },
  { name: '/specialists', description: 'List specialist agents' },
  { name: '/create-specialist', description: 'Create a specialist with guided AI assistance' },
  { name: '/candidates', description: 'Review specialist suggestions' },
  { name: '/options', description: 'View and set options (max-tokens, max-steps, …)' },
  { name: '/agent-options', description: 'Configure agent behavior (toggles, thresholds)' },
  { name: '/profiles', description: 'Switch / create settings profiles' },
  { name: '/manage-profiles', description: 'Rename or delete saved profiles' },
  { name: '/update', description: 'Check for and install updates' },
  { name: '/exit', description: 'Quit Bernard' },
];

/** Returns the subset of commands whose name prefix-matches the buffer. */
export function matchSlashCommands(buffer: string): SlashCommand[] {
  if (!buffer.startsWith('/')) return [];
  // Hide hints once the user has started typing args (a space terminates the
  // command token); they're past the picker at that point.
  if (buffer.includes(' ')) return [];
  const query = buffer.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(query));
}

interface SlashHintsProps {
  /** Filtered match list, computed by the caller so navigation state agrees. */
  matches: readonly SlashCommand[];
  /** Currently-highlighted index. Out-of-range values render nothing highlighted. */
  selectedIndex: number;
}

/**
 * Hint strip rendered under `<Prompt>`. The caller owns the filtered match
 * list and the selection cursor so up/down navigation in the prompt stays in
 * sync with what's displayed here.
 */
export function SlashHints({ matches, selectedIndex }: SlashHintsProps) {
  const colors = getThemeColors();
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {matches.map((cmd, idx) => {
        const selected = idx === selectedIndex;
        return (
          <Box key={cmd.name}>
            <Text color={selected ? colors.accent : undefined} bold={selected}>
              {selected ? '› ' : '  '}
              {cmd.name}
            </Text>
            <Text dimColor> — {cmd.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
