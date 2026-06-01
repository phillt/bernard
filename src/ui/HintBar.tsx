import { Box, Text } from 'ink';
import { getThemeColors } from '../theme.js';

interface HintBarProps {
  busy: boolean;
  overlayActive: boolean;
  slashActive: boolean;
}

interface Hint {
  key: string;
  label: string;
}

/**
 * Renders contextual keystroke hints in the bottom-left, mirroring StatusBar
 * on the right. Picks the hint set from the most-specific state first:
 * overlay → busy → slash autocomplete → idle. The same physical row holds
 * both bars so the chrome stays a single line.
 */
export function HintBar({ busy, overlayActive, slashActive }: HintBarProps) {
  const colors = getThemeColors();
  const hints = pickHints({ busy, overlayActive, slashActive });
  return (
    <Box>
      {hints.map((hint, idx) => (
        <Text key={hint.key} color={colors.muted}>
          {idx > 0 ? '  ·  ' : ''}
          <Text color={colors.accent}>{hint.key}</Text> {hint.label}
        </Text>
      ))}
    </Box>
  );
}

function pickHints(state: HintBarProps): Hint[] {
  if (state.overlayActive) {
    return [{ key: 'esc', label: 'close' }];
  }
  if (state.busy) {
    return [{ key: 'esc', label: 'interrupt' }];
  }
  if (state.slashActive) {
    return [
      { key: '↑↓', label: 'select' },
      { key: 'tab', label: 'complete' },
      { key: '↵', label: 'run' },
    ];
  }
  return [
    { key: '/', label: 'commands' },
    { key: 'shift+tab', label: 'status' },
  ];
}
