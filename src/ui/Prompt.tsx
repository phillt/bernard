import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../theme.js';
import { SlashHints, matchSlashCommands } from './SlashHints.js';

interface PromptProps {
  /** When true, suppress key handling — used while an overlay is open. */
  disabled?: boolean;
  /** Called on Enter with the current buffer (trimmed of trailing newline). */
  onSubmit: (text: string) => void;
  /**
   * Fired whenever the slash-hint strip toggles. Lets the parent show the
   * contextual hint bar without lifting the whole input buffer out of Prompt.
   */
  onSlashActiveChange?: (active: boolean) => void;
}

/**
 * Single-line input box. Uses Ink's `useInput` directly so the surface area
 * stays small (no `ink-text-input` dep). Maintains its own buffer state and
 * emits `onSubmit(text)` on Enter; an empty buffer is rejected silently to
 * match the legacy prompt's behavior.
 *
 * Slash-command autocomplete: when the buffer starts with `/` and has no
 * trailing args, a hint strip renders directly below the input. Up/Down
 * arrows move the selection; Tab completes the highlighted name into the
 * buffer (keeps focus so the user can add args); Enter submits the
 * highlighted command. Once the user types a space, hints clear and Enter
 * submits the literal buffer.
 */
export function Prompt({ disabled = false, onSubmit, onSlashActiveChange }: PromptProps) {
  const [buffer, setBuffer] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const colors = getThemeColors();

  const matches = useMemo(() => matchSlashCommands(buffer), [buffer]);
  // Clamp selection whenever the match list shrinks (e.g. user typed another
  // character and fewer commands match). Avoids dangling out-of-range cursor.
  const clampedIndex = matches.length === 0 ? 0 : Math.min(selectedIndex, matches.length - 1);

  // Keep the underlying state in sync with the clamped value so arrow-key
  // handlers don't decrement from a stale high index (e.g. 19 → 18 → 17 …)
  // when the list shrinks from 20 to 3.
  useEffect(() => {
    if (selectedIndex !== clampedIndex) setSelectedIndex(clampedIndex);
  }, [selectedIndex, clampedIndex]);

  const slashActive = matches.length > 0;
  useEffect(() => {
    onSlashActiveChange?.(slashActive);
  }, [slashActive, onSlashActiveChange]);

  useInput(
    (input, key) => {
      if (key.return) {
        // Highlighted slash command wins over the literal buffer.
        if (matches.length > 0) {
          const picked = matches[clampedIndex];
          setBuffer('');
          setSelectedIndex(0);
          onSubmit(picked.name);
          return;
        }
        const text = buffer.trim();
        if (text.length === 0) return;
        setBuffer('');
        setSelectedIndex(0);
        onSubmit(text);
        return;
      }
      if (matches.length > 0 && key.upArrow) {
        setSelectedIndex((i) => (i <= 0 ? matches.length - 1 : i - 1));
        return;
      }
      if (matches.length > 0 && key.downArrow) {
        setSelectedIndex((i) => (i >= matches.length - 1 ? 0 : i + 1));
        return;
      }
      if (matches.length > 0 && key.tab) {
        // Autocomplete: drop the highlighted command into the buffer and add a
        // trailing space so the user can type args without re-typing the name.
        const picked = matches[clampedIndex];
        setBuffer(picked.name + ' ');
        setSelectedIndex(0);
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
        setSelectedIndex(0);
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor={disabled ? colors.muted : colors.accent} paddingX={1}>
        <Text>
          <Text color={colors.accent} bold>
            {'› '}
          </Text>
          <Text>{buffer}</Text>
          {!disabled ? <Text color={colors.accent}>{'▌'}</Text> : null}
        </Text>
      </Box>
      <SlashHints matches={matches} selectedIndex={clampedIndex} />
    </Box>
  );
}
