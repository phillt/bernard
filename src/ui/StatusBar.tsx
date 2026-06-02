import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { getThemeColors } from '../theme.js';
import { formatTokenCount, type SpinnerStats } from '../output.js';
import { getContextWindow, COMPRESSION_THRESHOLD } from '../context.js';
import type { Agent } from '../agent.js';

interface StatusBarProps {
  agent: Agent;
}

const BAR_WIDTH = 10;

/**
 * Pinned bottom-right token / context-window readout. Polls `agent.spinnerStats`
 * every 500 ms — cheap, and only mutated by the token-stats hook on step
 * boundaries, so a poll-based refresh is fine (no subscription seam needed).
 * The compression-headroom indicator is a `[████░░░░░░]` bar that gets louder
 * as it fills: muted while there's >25% headroom, warning between 5%–25%, and
 * the theme's accent color once <5% of the compression budget is left.
 */
export function StatusBar({ agent }: StatusBarProps) {
  const colors = getThemeColors();
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);

  const stats: SpinnerStats | null = agent.spinnerStats;
  const strategy = agent.currentStrategy;
  if (!stats && !strategy) return null;

  const up = stats ? formatTokenCount(stats.totalPromptTokens) : '0';
  const down = stats ? formatTokenCount(stats.totalCompletionTokens) : '0';
  const contextWindow = stats ? getContextWindow(stats.model, stats.contextWindowOverride) : 1;
  const thresholdTokens = contextWindow * COMPRESSION_THRESHOLD;
  const usedFrac = stats ? Math.min(1, Math.max(0, stats.latestPromptTokens / thresholdTokens)) : 0;
  const freePct = (1 - usedFrac) * 100;

  const filledCount = Math.round(usedFrac * BAR_WIDTH);
  const emptyCount = BAR_WIDTH - filledCount;

  // Three-stop color ramp keyed to remaining compression headroom. The filled
  // dots get progressively louder as the model's input window approaches the
  // compression cliff; the empty trailing dots stay muted so the active
  // portion pops.
  const fillColor = freePct > 25 ? colors.muted : freePct > 5 ? colors.warning : colors.accent;

  return (
    <Box justifyContent="flex-end">
      {strategy && (
        <Text color={strategy === 'react' ? colors.accent : colors.muted}>
          {strategy === 'react' ? '◆ coordinator' : '◇ normal'}
          {'   '}
        </Text>
      )}
      {stats && (
        <Text color={colors.muted}>
          {up}↑ {down}↓{'   '}
        </Text>
      )}
      {filledCount > 0 && <Text color={fillColor}>{'●'.repeat(filledCount)}</Text>}
      {emptyCount > 0 && (
        <Text color={colors.muted} dimColor>
          {'○'.repeat(emptyCount)}
        </Text>
      )}
    </Box>
  );
}
