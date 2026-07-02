import { Box } from 'ink';
import { HintRow, type KeyHint } from './hints.js';

interface HintBarProps {
  busy: boolean;
  overlayActive: boolean;
  slashActive: boolean;
  /** Full-screen mode — surface a transcript scroll hint in the idle row. */
  scrollable?: boolean;
}

/**
 * Renders contextual keystroke hints in the bottom-left, mirroring StatusBar
 * on the right. Picks the hint set from the most-specific state first:
 * overlay → busy → slash autocomplete → idle. The same physical row holds
 * both bars so the chrome stays a single line. Shares the accent-key/muted-label
 * rendering with the Shift+Tab viewer legend via {@link HintRow}.
 */
export function HintBar({ busy, overlayActive, slashActive, scrollable }: HintBarProps) {
  return (
    <Box>
      <HintRow hints={pickHints({ busy, overlayActive, slashActive, scrollable })} />
    </Box>
  );
}

function pickHints(state: HintBarProps): KeyHint[] {
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
  const idle: KeyHint[] = [
    { key: '/', label: 'commands' },
    { key: 'shift+tab', label: 'status' },
  ];
  // In full-screen the transcript scrolls in-app (no native scrollback).
  if (state.scrollable) idle.push({ key: '⇞⇟', label: 'scroll' });
  return idle;
}
