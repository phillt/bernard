import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Box, Text } from 'ink';
import { getThemeColors } from '../theme.js';
import { formatTokenCount, finiteOr0, type SpinnerStats } from '../output.js';
import { formatTurnCost, formatCostSuffix } from '../usage-report.js';
import { getContextWindow, COMPRESSION_THRESHOLD } from '../context.js';
import type { Agent } from '../agent.js';

interface StatusBarProps {
  agent: Agent;
}

const BAR_WIDTH = 10;

/** Pulse decay duration in ms — short enough to feel snappy, long enough to notice. */
const PULSE_DECAY_MS = 250;

/** Snapshot of the fields StatusBar renders, for change detection and pulse comparison. */
interface StatsSnapshot {
  display: string;
  up: number;
  down: number;
}

/** Serialize the fields StatusBar actually renders, for change detection. */
function snapshotStats(stats: SpinnerStats | null, strategy: string | null): StatsSnapshot {
  if (!stats) return { display: `null|${strategy ?? ''}`, up: 0, down: 0 };
  const up = stats.turnPromptTokens;
  const down = stats.turnCompletionTokens;
  return {
    display: [
      up,
      down,
      stats.latestPromptTokens,
      stats.model,
      stats.contextWindowOverride ?? '',
      stats.sessionCostUsd,
      strategy ?? '',
    ].join('|'),
    up,
    down,
  };
}

/**
 * Arm (or re-arm) a pulse: set the active flag, clear any pending decay timer,
 * and schedule a new decay after `decayMs`. Extracted to eliminate the
 * identical arm/re-arm block that would otherwise appear for each direction.
 */
function armPulse(
  setActive: (v: boolean) => void,
  timeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
  decayMs: number,
): void {
  setActive(true);
  if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
  timeoutRef.current = setTimeout(() => {
    setActive(false);
    timeoutRef.current = null;
  }, decayMs);
}

/**
 * Pinned bottom-right token / context-window readout. Polls `agent.spinnerStats`
 * every 500 ms — cheap, and only mutated by the token-stats hook on step
 * boundaries, so a poll-based refresh is fine (no subscription seam needed).
 * The poll only forces a re-render when a rendered value actually changed
 * (#232): when the agent is idle nothing mutates `spinnerStats`, so the
 * snapshot is stable and the dynamic region stops repainting — which is what
 * lets the terminal hold its scroll position while idle.
 * The compression-headroom indicator is a `●●●◐○○○○○○` dot gauge (half-dot
 * resolution) that gets louder as it fills: muted while there's >25% headroom,
 * warning between 5%–25%, and the theme's accent color once <5% of the
 * compression budget is left.
 * Token counter pulse (#246): when `turnPromptTokens` or `turnCompletionTokens`
 * increases, the corresponding `↑`/`↓` counter briefly brightens to the accent
 * color for ~250 ms, then decays back to muted. Rapid successive increments
 * restart the timer (extend the pulse) rather than stacking timeouts.
 */
export function StatusBar({ agent }: StatusBarProps) {
  const colors = getThemeColors();
  const [, force] = useState(0);
  const lastSnapshotRef = useRef<StatsSnapshot>(snapshotStats(agent.spinnerStats, agent.currentStrategy));

  // Per-direction pulse state: true while the accent highlight is active.
  const [upPulse, setUpPulse] = useState(false);
  const [downPulse, setDownPulse] = useState(false);

  // Pending decay timeout handles — cleared on rapid successive increments and on unmount.
  const upTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const snap = snapshotStats(agent.spinnerStats, agent.currentStrategy);
      if (snap.display !== lastSnapshotRef.current.display) {
        const prev = lastSnapshotRef.current;
        lastSnapshotRef.current = snap;

        // Pulse the ↑ counter if prompt tokens increased.
        if (snap.up > prev.up) armPulse(setUpPulse, upTimeoutRef, PULSE_DECAY_MS);

        // Pulse the ↓ counter if completion tokens increased.
        if (snap.down > prev.down) armPulse(setDownPulse, downTimeoutRef, PULSE_DECAY_MS);

        force((n) => n + 1);
      }
    }, 500);
    return () => {
      clearInterval(id);
      // React 18 batches setState and no-ops on unmounted components;
      // just cancel the timers so they don't fire after unmount.
      clearTimeout(upTimeoutRef.current ?? undefined);
      clearTimeout(downTimeoutRef.current ?? undefined);
    };
  }, [agent]);

  const stats: SpinnerStats | null = agent.spinnerStats;
  const strategy = agent.currentStrategy;
  if (!stats && !strategy) return null;

  const up = stats ? formatTokenCount(stats.turnPromptTokens) : '0';
  const down = stats ? formatTokenCount(stats.turnCompletionTokens) : '0';
  // Estimated turn cost (#258), e.g. ` ~$0.07`. Empty when no priced tokens yet.
  const cost = formatTurnCost(stats);
  // Cumulative session cost across all turns; rendered only once it's > 0.
  const sessionSuffix = formatCostSuffix(stats?.sessionCostUsd);
  const sessionCost = sessionSuffix ? `session ${sessionSuffix}   ` : '';
  const latestPromptTokens = stats ? finiteOr0(stats.latestPromptTokens) : 0;
  const contextWindow = stats ? getContextWindow(stats.model, stats.contextWindowOverride) : 1;
  const thresholdTokens = contextWindow * COMPRESSION_THRESHOLD;
  const usedFrac = stats ? Math.min(1, Math.max(0, latestPromptTokens / thresholdTokens)) : 0;
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
      {/* The token readout + context gauge only render once real token stats
          exist — before the first stats flush (strategy set, stats still null)
          an all-empty bar would be visual noise. `turn` is the per-turn
          odometer (full turn cost — main agent plus any sub-agents / wrappers /
          PAC it spawns — reset each turn); `ctx` is the current main-agent input
          size (latest step's prompt tokens) — the number the gauge actually
          depicts, so the two can't be confused. */}
      {stats && (
        <>
          <Text color={colors.muted}>turn </Text>
          <Text color={upPulse ? colors.accent : colors.muted} bold={upPulse}>
            {up}↑{' '}
          </Text>
          <Text color={downPulse ? colors.accent : colors.muted} bold={downPulse}>
            {down}↓
          </Text>
          <Text color={colors.muted}>{cost}{'   '}</Text>
          {sessionCost ? <Text color={colors.muted}>{sessionCost}</Text> : null}
          <Text color={colors.muted}>ctx {formatTokenCount(stats.latestPromptTokens)} </Text>
          {filledCount > 0 && <Text color={fillColor}>{'●'.repeat(filledCount)}</Text>}
          {halfCount > 0 && <Text color={fillColor}>◐</Text>}
          {emptyCount > 0 && (
            <Text color={colors.muted} dimColor>
              {'○'.repeat(emptyCount)}
            </Text>
          )}
        </>
      )}
    </Box>
  );
}
