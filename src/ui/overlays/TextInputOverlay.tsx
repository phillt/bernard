import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import type { ValuePromptOptions, ValueResult } from '../menu-types.js';

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
  const [buffer, setBuffer] = useState(options.initialValue ?? '');
  const cancelOnEmpty = options.cancelOnEmpty !== false;

  useInput((input, key) => {
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
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      return;
    }
    // Filter non-printable control keys; allow regular characters and space.
    if (input && !key.ctrl && !key.meta) {
      setBuffer((b) => b + input);
    }
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
        {showPlaceholder ? <Text dimColor>{options.placeholder}</Text> : <Text>{buffer}</Text>}
        <Text color={colors.accent}>▎</Text>
      </Box>
      <Text> </Text>
      <Text dimColor>Enter commit · Esc cancel</Text>
    </Box>
  );
}
