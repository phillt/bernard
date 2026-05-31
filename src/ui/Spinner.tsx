import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { getThemeColors } from '../theme.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface SpinnerProps {
  /** Optional status label shown next to the animation. */
  label?: string;
}

/**
 * Braille-dot spinner. Mounted while the agent is processing a turn so the
 * user has a visible "still working" signal. Streaming token output lands in
 * Phase C; until then this is the only mid-turn feedback the Ink shell shows.
 */
export function Spinner({ label }: SpinnerProps) {
  const [frame, setFrame] = useState(0);
  const colors = getThemeColors();
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return (
    <Text color={colors.accent}>
      {FRAMES[frame]}
      {label ? ` ${label}` : ''}
    </Text>
  );
}
