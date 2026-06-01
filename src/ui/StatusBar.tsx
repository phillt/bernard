import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { getThemeColors } from '../theme.js';
import { buildStatusLine, type SpinnerStats } from '../output.js';
import type { Agent } from '../agent.js';

interface StatusBarProps {
  agent: Agent;
}

/**
 * Pinned bottom-right token / context-window readout. Polls `agent.spinnerStats`
 * every 500 ms — cheap, and only mutated by the token-stats hook on step
 * boundaries, so a poll-based refresh is fine (no subscription seam needed).
 * Renders nothing until the agent has accumulated at least one step's usage.
 */
export function StatusBar({ agent }: StatusBarProps) {
  const colors = getThemeColors();
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);

  const stats: SpinnerStats | null = agent.spinnerStats;
  if (!stats || (stats.totalPromptTokens === 0 && stats.totalCompletionTokens === 0)) {
    return null;
  }
  return (
    <Box justifyContent="flex-end">
      <Text color={colors.muted}>{buildStatusLine(stats)}</Text>
    </Box>
  );
}
