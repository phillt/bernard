import { Box } from 'ink';
import { MenuRow } from './overlays/MenuRow.js';
import { type SlashCommand } from './slash-commands.js';

// The catalogue itself lives in `slash-commands.js` — plain data, no Ink — and
// is re-exported here so importers that predate the split keep working.
export { SLASH_COMMANDS, matchSlashCommands, type SlashCommand } from './slash-commands.js';

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
