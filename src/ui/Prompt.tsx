import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../theme.js';
import { SlashHints } from './SlashHints.js';

interface PromptProps {
  /** When true, suppress key handling — used while an overlay is open. */
  disabled?: boolean;
  /** Called on Enter with the current buffer (trimmed of trailing newline). */
  onSubmit: (text: string) => void;
}

/**
 * Single-line input box. Uses Ink's `useInput` directly so the surface area
 * stays small (no `ink-text-input` dep). Maintains its own buffer state and
 * emits `onSubmit(text)` on Enter; an empty buffer is rejected silently to
 * match the legacy prompt's behavior.
 *
 * Disabled while an overlay is open so the overlay can capture keystrokes
 * exclusively. Phase D will extend this with paste handling and history
 * navigation when the readline path is retired.
 */
export function Prompt({ disabled = false, onSubmit }: PromptProps) {
  const [buffer, setBuffer] = useState('');
  const colors = getThemeColors();

  useInput(
    (input, key) => {
      if (key.return) {
        const text = buffer.trim();
        if (text.length === 0) return;
        setBuffer('');
        onSubmit(text);
        return;
      }
      if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta) return;
      // Ignore arrow / function keys — `input` is empty for those.
      if (input && !key.escape && !key.tab) {
        setBuffer((b) => b + input);
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <SlashHints buffer={buffer} />
      <Box>
        <Text color={colors.accent} bold>
          ›{' '}
        </Text>
        <Text>{buffer}</Text>
        {!disabled && <Text color={colors.accent}>▌</Text>}
      </Box>
    </Box>
  );
}
