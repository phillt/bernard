import { Box, Text, useInput } from 'ink';
import { isDismissKey } from './overlay-contract.js';
import { getThemeColors } from '../../theme.js';
import { HintRow, KEY, HINT_CANCEL } from '../hints.js';
import type { ValuePromptOptions, ValueResult } from '../menu-types.js';
import { useRawKeys } from '../useRawKeys.js';
import { useLineEditor } from '../use-line-editor.js';
import { BoundedLine, OVERLAY_RESERVED_COLUMNS } from '../BoundedLine.js';

interface TextInputOverlayProps {
  options: ValuePromptOptions;
  onResolve: (result: ValueResult) => void;
}

/**
 * Ink replacement for the readline `promptValue()` flow. Renders a labeled
 * input field with cursor; commits on Enter, cancels on Esc. (Ctrl-C quits
 * Bernard rather than reaching here — see `overlay-contract.ts`.)
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
  // Always enabled: this overlay is mounted only while it owns the screen.
  useRawKeys((key) => {
    if (key === 'home') editor.toLineStart();
    else editor.toLineEnd();
  }, true);
  const { buffer } = editor;
  const cancelOnEmpty = options.cancelOnEmpty !== false;

  useInput((input, key) => {
    // Dismiss runs BEFORE the editor, which now claims six Ctrl letters
    // (a/e/w/u/k/d) where it once claimed two — so ceding the keystream first
    // is what keeps Esc from reaching the buffer.
    //
    // `isDismissKey`, not `isDismissKeyWithQ`: this is the one surface where a
    // character can land in a buffer, so `q` has to stay typeable.
    if (isDismissKey(input, key)) {
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
      {/* Label and input are stacked, not side by side (#354). As siblings in
          a row `Box` they were separate flex items, so text could not reflow
          across the boundary and a long answer ran off the right edge — while
          `Prompt.tsx` wraps because it puts its prefix and buffer in ONE
          `<Text>` flow. Stacking is better than merging them here: it gives
          the answer the full frame width rather than `width − label.length`,
          which matters because labels are not always short (`ask_user` passes
          a model-written question; the custom-provider wizard passes 66
          characters). */}
      <Text color={colors.accent}>{options.label}:</Text>
      {showPlaceholder ? (
        <Text>
          <Text color={colors.muted}>{options.placeholder}</Text>
          <Text color={colors.accent}>▎</Text>
        </Text>
      ) : (
        <BoundedLine
          buffer={buffer}
          cursor={editor.cursor}
          showCursor
          cursorColor={colors.accent}
          cursorGlyph="▎"
          reserveColumns={OVERLAY_RESERVED_COLUMNS}
        />
      )}
      <Text> </Text>
      <HintRow hints={[{ key: KEY.enter, label: 'commit' }, HINT_CANCEL]} />
    </Box>
  );
}
