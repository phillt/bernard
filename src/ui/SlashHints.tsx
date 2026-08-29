import { Box } from 'ink';
import { MenuRow } from './overlays/MenuRow.js';

export interface SlashCommand {
  name: string;
  /** One-line gloss for the prompt-adjacent hint strip, which is narrow. */
  description: string;
  /**
   * The longer wording for the help screen, which has a full frame to spend.
   * Falls back to {@link description} when absent — most commands say the same
   * thing in both places and should not carry two strings to drift apart.
   *
   * It exists because a handful genuinely read differently by surface: `/help`'s
   * row inside the help screen is "Show this help" (deictic — correct only
   * there) while the hint strip, where the screen is not open, must say "Show
   * command list". Forcing one wording on both would have been the cheaper
   * single-source, and would have made one of the two surfaces worse.
   */
  detail?: string;
}

/**
 * The single source of truth for Bernard's slash commands (#390).
 *
 * This list feeds **both** the autocomplete hint strip (via
 * {@link matchSlashCommands}) and the `Commands` section of `<HelpOverlay>`,
 * which derives its rows from here rather than keeping a second table. It used
 * to keep one, and the only mechanism holding the two together was a comment
 * telling the reader to sync them by hand: they had drifted to 33 vs. 30
 * entries with four disagreeing descriptions, and `/session-log` — a working
 * command — appeared in neither.
 *
 * `<App>.handleSubmit`'s if-chain remains a third, unsynchronised source. It
 * cannot be derived from here (its branches close over REPL state), so
 * `__tests__/slash-catalogue.test.ts` reconciles the two by reading that file
 * as source text — see its header for why that is a stopgap and what the real
 * fix is. Adding a command means adding it here AND to that dispatch.
 *
 * Items the user can't dispatch directly from the prompt (variants with
 * required args) belong in the help screen, not here.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/help', description: 'Show command list', detail: 'Show this help' },
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
  { name: '/usage', description: 'Last turn token + cost breakdown by tier (alias /cost)' },
  { name: '/session-log', description: 'Show the debug session-log path (BERNARD_DEBUG=1)' },
  { name: '/lineup', description: 'Edit the active lineup (per-role × premium/mid/cheap)' },
  { name: '/lineups', description: 'List, switch, or create tier lineups' },
  { name: '/models', description: 'Browse the model catalog and add custom providers' },
  { name: '/refresh-models', description: 'Force-refresh the model catalog from the gateway' },
  { name: '/provider', description: 'Manage providers (alias of /models)' },
  { name: '/theme', description: 'Switch color theme' },
  { name: '/voice', description: 'Toggle text-to-speech readback and backend' },
  { name: '/routines', description: 'List saved routines' },
  { name: '/create-routine', description: 'Create a routine with guided AI assistance' },
  { name: '/create-task', description: 'Create a task routine with guided AI assistance' },
  { name: '/specialists', description: 'List specialist agents' },
  { name: '/create-specialist', description: 'Create a specialist with guided AI assistance' },
  { name: '/candidates', description: 'Review specialist suggestions' },
  {
    name: '/options',
    description: 'View and set options (max-tokens, max-steps, …)',
    detail: 'View and set options (max-tokens, max-steps, shell-timeout, token-window)',
  },
  {
    name: '/agent-options',
    description: 'Configure agent behavior (toggles, thresholds)',
    detail: 'Configure agent behavior (toggles, thresholds, saved assets)',
  },
  {
    name: '/tool-permissions',
    description: 'View/remove profile tool grants; skip-permissions toggle',
    detail: 'View/remove profile tool grants; toggle skip-permissions mode',
  },
  { name: '/profiles', description: 'Switch / create settings profiles' },
  { name: '/manage-profiles', description: 'Rename or delete saved profiles' },
  { name: '/update', description: 'Check for and install updates' },
  { name: '/exit', description: 'Quit Bernard (alias /quit)' },
];

/**
 * Returns the subset of commands whose name prefix-matches the buffer. `extra`
 * carries dynamic, session-specific commands — the user's saved routines and
 * tasks — so typing `/my-routine` autocompletes the same way a built-in does.
 */
export function matchSlashCommands(
  buffer: string,
  extra: readonly SlashCommand[] = [],
): SlashCommand[] {
  if (!buffer.startsWith('/')) return [];
  // Hide hints once the user has started typing args (a space terminates the
  // command token); they're past the picker at that point.
  if (buffer.includes(' ')) return [];
  const query = buffer.slice(1).toLowerCase();
  return [...SLASH_COMMANDS, ...extra].filter((c) =>
    c.name.slice(1).toLowerCase().startsWith(query),
  );
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
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {matches.map((cmd, idx) => (
        <MenuRow
          key={cmd.name}
          selected={idx === selectedIndex}
          label={cmd.name}
          trailing={` — ${cmd.description}`}
        />
      ))}
    </Box>
  );
}
