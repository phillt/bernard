import { Box } from 'ink';
import { HintRow, KEY, HINT_CLOSE, type KeyHint } from './hints.js';
import { OPTIONS_KEY, isAutomatic, type RemoteMessageMode } from '../remote-messages.js';

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
  pendingMessage: boolean;
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
  remoteMode: RemoteMessageMode;
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
    // The prompt is live during a turn (#202), and this row is the only thing
    // on screen that says what typing into it will do. Plain Enter first: it
    // steers the work in flight (#200), which is the common case and the one
    // the plain keystroke is for. `+` waits until the turn is over. Interrupt
    // last, because it throws away the work already done — the cost both
    // exist to stop the user paying to say one sentence.
    return [
      { key: KEY.enter, label: 'tell bernard now' },
      { key: '+', label: 'queue for after' },
      { key: KEY.esc, label: 'interrupt' },
    ];
  }
  if (state.slashActive) {
    return [
      { key: KEY.arrows, label: 'select' },
      { key: 'tab', label: 'complete' },
      { key: KEY.enter, label: 'run' },
    ];
  }
  const idle: KeyHint[] = [];
  // Ahead of the standing hints. Two independent facts, not two branches of one:
  // a pending message is transient and answers something that just appeared,
  // while the mode is a STATE worth disclosing on its own — in `all` or
  // `prompts` any local process that can write the state directory can start a
  // turn here, and nothing else on screen says so.
  //
  // They were an if/else under a comment asserting "both cannot be true", which
  // is false: `prompts` runs a `--run` and leaves a plain notice pending, so the
  // disclosure was suppressed in exactly the case it exists for. `^o` appears
  // once either way and its label says which fact it is about.
  if (state.pendingMessage) idle.push({ key: KEY.enter, label: 'act on message' });
  if (state.pendingMessage || isAutomatic(state.remoteMode)) {
    idle.push({
      key: OPTIONS_KEY,
      label: isAutomatic(state.remoteMode) ? `messages: ${state.remoteMode}` : 'options',
    });
  }
  idle.push({ key: '/', label: 'commands' }, { key: KEY.shiftTab, label: 'status' });
  // In full-screen the transcript scrolls in-app (no native scrollback).
  if (state.scrollable) idle.push({ key: KEY.pageKeys, label: 'scroll' });
  return idle;
}
