import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { getThemeColors } from '../theme.js';
import { formatElapsed } from '../output.js';
import { LONG_CALL_NOTICE_MS, pendingCallNotice } from '../tools/in-flight.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface SpinnerProps {
  /** Optional status label shown next to the animation. */
  label?: string;
}

/**
 * Braille-dot spinner. Mounted while the agent is processing a turn so the
 * user has a visible "still working" signal.
 *
 * It also names a tool call that has been running too long (#594). A dead MCP
 * server held one turn for 35 minutes and this line said `thinking…` for all of
 * them, while the runner's watchdog computed the fact every 30 seconds and threw
 * it away into a `debugLog` nobody had enabled.
 *
 * Read here rather than lifted into `App` state because this component is the
 * one thing on screen already ticking: it re-renders every 80 ms regardless, so
 * a map scan per frame costs nothing and adds no second timer, no App-level
 * state churn and no whole-tree re-render each second. `StatusBar` polls
 * `agent.spinnerStats` on its own interval for the same reason.
 */
export function Spinner({ label }: SpinnerProps) {
  const [frame, setFrame] = useState(0);
  const colors = getThemeColors();
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  const pending = pendingCallNotice(Date.now(), LONG_CALL_NOTICE_MS);
  return (
    <Text color={colors.accent}>
      {FRAMES[frame]}
      {label ? ` ${label}` : ''}
      {pending ? (
        <Text color={colors.muted}>{` · ${pending.label} ${formatElapsed(pending.ms)}`}</Text>
      ) : null}
    </Text>
  );
}
