import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import type { ValuePromptOptions, ValueResult } from '../menu-types.js';
import { useLineEditor, LineWithCursor } from '../use-line-editor.js';

interface TextInputOverlayProps {
  options: ValuePromptOptions;
  onResolve: (result: ValueResult) => void;
}

/**
 * Ink replacement for the readline `promptValue()` flow. Renders a labeled
 * input field with cursor; commits on Enter, cancels on Esc / Ctrl-C.
 *
 * Phase D (#215) seam: the legacy REPL called `promptValue(rl, ...)` for
 * every free-text mutation (new profile name, new specialist description,
 * new model name, etc.). Those call sites now route through
 * `requestTextInput(...)` on `<App>` which mounts this overlay.
 *
 * Cancellation semantics match the legacy path: an empty submission cancels
 * unless `cancelOnEmpty: false` is passed (rarely needed — every existing
 * caller treated empty as cancel).
 */
export function TextInputOverlay({ options, onResolve }: TextInputOverlayProps) {
  const colors = getThemeColors();
  const editor = useLineEditor(options.initialValue ?? '');
  const { buffer } = editor;
  const cancelOnEmpty = options.cancelOnEmpty !== false;

  useInput((input, key) => {
    // Ctrl-C must run before the editor, which consumes other Ctrl combos
    // (Ctrl-A / Ctrl-E move the cursor to start / end).
    if (key.ctrl && input === 'c') {
      onResolve({ cancelled: true });
      return;
    }
    if (key.escape) {
      onResolve({ cancelled: true });
      return;
    }
    if (key.return) {
      const trimmed = buffer.trim();
      if (cancelOnEmpty && trimmed.length === 0) {
        onResolve({ cancelled: true });
        return;
      }
      onResolve({ cancelled: false, raw: trimmed });
      return;
    }
    // Cursor movement, backspace-at-cursor, and printable insertion all live
    // in the shared line editor (see use-line-editor.tsx).
    editor.handleKey(input, key);
  });

  const showPlaceholder = buffer.length === 0 && options.placeholder;
  return (
    <Box flexDirection="column" marginTop={1}>
      {options.headerLines?.map((line, idx) => (
        <Text key={`h-${idx}`}>{line}</Text>
      ))}
      {options.headerLines && options.headerLines.length > 0 && <Text> </Text>}
      <Box>
        <Text color={colors.accent}>{options.label}: </Text>
        {showPlaceholder ? (
          <Text>
            <Text dimColor>{options.placeholder}</Text>
            <Text color={colors.accent}>▎</Text>
          </Text>
        ) : (
          <LineWithCursor
            buffer={buffer}
            cursor={editor.cursor}
            showCursor
            cursorColor={colors.accent}
            cursorGlyph="▎"
          />
        )}
      </Box>
      <Text> </Text>
      <Text dimColor>Enter commit · Esc cancel</Text>
    </Box>
  );
}
