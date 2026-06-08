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
 * The compression-headroom indicator is a `●●●◐○○○○○○` dot gauge (half-dot
 * resolution) that gets louder as it fills: muted while there's >25% headroom,
 * warning between 5%–25%, and the theme's accent color once <5% of the
 * compression budget is left.
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

  // Quantize the fill to half-dot resolution: a dot whose fractional fill
  // lands in [0.25, 0.75) renders as ◐ instead of rounding to fully on/off,
  // doubling the gauge's granularity (BAR_WIDTH dots → 2×BAR_WIDTH states).
  const exactFill = usedFrac * BAR_WIDTH;
  let filledCount = Math.floor(exactFill);
  const remainder = exactFill - filledCount;
  let halfCount = 0;
  if (remainder >= 0.75) filledCount += 1;
  else if (remainder >= 0.25) halfCount = 1;
  const emptyCount = BAR_WIDTH - filledCount - halfCount;

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
          session {up}↑ {down}↓{'   '}
        </Text>
      )}
      {/* Context gauge only renders once real token stats exist — before the
          first stats flush (strategy set, stats still null) an all-empty bar
          would be visual noise. The `ctx` readout is the current input size
          (latest step's prompt tokens) — the number the gauge actually depicts,
          so it can't be confused with the cumulative `session` odometer above. */}
      {stats && (
        <Text color={colors.muted}>ctx {formatTokenCount(stats.latestPromptTokens)} </Text>
      )}
      {stats && filledCount > 0 && <Text color={fillColor}>{'●'.repeat(filledCount)}</Text>}
      {stats && halfCount > 0 && <Text color={fillColor}>◐</Text>}
      {stats && emptyCount > 0 && (
        <Text color={colors.muted} dimColor>
          {'○'.repeat(emptyCount)}
        </Text>
      )}
    </Box>
  );
}
