import { Box } from 'ink';
import { HintRow, KEY, HINT_CLOSE, type KeyHint } from './hints.js';
import { OPTIONS_KEY, type RemoteMessageMode } from './remote-messages.js';

interface HintBarProps {
  busy: boolean;
  overlayActive: boolean;
  slashActive: boolean;
  /** Full-screen mode — surface a transcript scroll hint in the idle row. */
  scrollable?: boolean;
  /**
   * A delivered message is waiting to be acted on (#462).
   *
   * The live half of the notice panel's footer. That footer is frozen at arrival
   * — Ink's `<Static>` never repaints an existing item — so it records what was
   * true when the message landed, the way its timestamp does, and this row is
   * what says the keystroke works *right now*.
   */
  pendingMessage?: boolean;
  /**
   * What this session does with a message that arrives (#462).
   *
   * Shown only when it is NOT `ask`, for two reasons that happen to want the
   * same row. It is a state worth disclosing — an automatic mode means any local
   * process that can write the state directory can start a turn here, and
   * nothing else on screen says so. And it is the only signpost back: once a
   * mode runs everything, no message is ever pending, so the keystroke menu that
   * offered "…and on this profile" had nothing to open on.
   */
  remoteMode?: RemoteMessageMode;
}

/**
 * Renders contextual keystroke hints in the bottom-left, mirroring StatusBar
 * on the right. Picks the hint set from the most-specific state first:
 * overlay → busy → slash autocomplete → idle. The same physical row holds
 * both bars so the chrome stays a single line. Shares the accent-key/muted-label
 * rendering with the Shift+Tab viewer legend via {@link HintRow}.
 */
export function HintBar({
  busy,
  overlayActive,
  slashActive,
  scrollable,
  pendingMessage,
  remoteMode,
}: HintBarProps) {
  return (
    <Box>
      <HintRow
        hints={pickHints({
          busy,
          overlayActive,
          slashActive,
          scrollable,
          pendingMessage,
          remoteMode,
        })}
      />
    </Box>
  );
}

function pickHints(state: HintBarProps): KeyHint[] {
  if (state.overlayActive) {
    return [HINT_CLOSE];
  }
  if (state.busy) {
    return [{ key: KEY.esc, label: 'interrupt' }];
  }
  if (state.slashActive) {
    return [
      { key: KEY.arrows, label: 'select' },
      { key: 'tab', label: 'complete' },
      { key: KEY.enter, label: 'run' },
    ];
  }
  const idle: KeyHint[] = [];
  // Ahead of the standing hints, and mutually exclusive: the first is transient
  // and answers a thing that just appeared on screen; the second is a STATE and
  // is only shown because that state is worth disclosing. Both cannot be true —
  // an automatic mode means nothing is ever pending.
  if (state.pendingMessage) {
    idle.push({ key: KEY.enter, label: 'act on message' }, { key: OPTIONS_KEY, label: 'options' });
  } else if (state.remoteMode !== undefined && state.remoteMode !== 'ask') {
    idle.push({ key: OPTIONS_KEY, label: `messages: ${state.remoteMode}` });
  }
  idle.push({ key: '/', label: 'commands' }, { key: KEY.shiftTab, label: 'status' });
  // In full-screen the transcript scrolls in-app (no native scrollback).
  if (state.scrollable) idle.push({ key: KEY.pageKeys, label: 'scroll' });
  return idle;
}
