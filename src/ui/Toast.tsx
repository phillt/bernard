import { Box, Text } from 'ink';
import { getThemeColors } from '../theme.js';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

interface ToastProps {
  message: string;
  variant?: ToastVariant;
}

/**
 * Single-line status flash rendered between the thread and the prompt.
 *
 * Phase D (#215) replacement for the inline `printInfo` / `printError` calls
 * the legacy REPL fired after every slash-command mutation (e.g.
 * "Theme set to ocean.", "Specialist 'pirate' deleted."). `<App>` owns an
 * `infoToast` slot that is cleared on the next user submit so the flash
 * survives long enough to be read but doesn't accumulate above the prompt.
 */
export function Toast({ message, variant = 'info' }: ToastProps) {
  const colors = getThemeColors();
  const color =
    variant === 'error'
      ? colors.error
      : variant === 'warning'
        ? colors.warning
        : variant === 'success'
          ? colors.accent
          : undefined;
  const prefix =
    variant === 'error' ? '✗' : variant === 'warning' ? '!' : variant === 'success' ? '✓' : 'ℹ';
  return (
    <Box marginTop={1}>
      <Text color={color}>
        {prefix} {message}
      </Text>
    </Box>
  );
}
