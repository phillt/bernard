import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { getThemeColors } from '../theme.js';
import { formatTokenCount, finiteOr0, type SpinnerStats } from '../output.js';
import { formatAggCost, computeTurnUsageReport } from '../usage-report.js';
import { HintDivider, HintEntry } from './hints.js';
import { getContextWindow, COMPRESSION_THRESHOLD } from '../context.js';
import type { Agent } from '../agent.js';

interface StatusBarProps {
  agent: Agent;
}

const BAR_WIDTH = 10;

/** Pulse decay duration in ms — short enough to feel snappy, long enough to notice. */
const PULSE_DECAY_MS = 250;

/** Serialize the fields StatusBar actually renders, for change detection. */
function snapshotStats(stats: SpinnerStats | null, strategy: string | null): string {
  if (!stats) return `null|${strategy ?? ''}`;
  return [
    stats.turnPromptTokens,
    stats.turnCompletionTokens,
    stats.latestPromptTokens,
    stats.model,
    stats.contextWindowOverride ?? '',
    stats.sessionCostUsd,
    stats.sessionCostPartial,
    strategy ?? '',
  ].join('|');
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
  const lastSnapshotRef = useRef<string>(snapshotStats(agent.spinnerStats, agent.currentStrategy));

  // Per-direction pulse state: true while the accent highlight is active.
  const [upPulse, setUpPulse] = useState(false);
  const [downPulse, setDownPulse] = useState(false);

  // Track previous token values so we can detect increases.
  const prevUpRef = useRef<number>(agent.spinnerStats?.turnPromptTokens ?? 0);
  const prevDownRef = useRef<number>(agent.spinnerStats?.turnCompletionTokens ?? 0);

  // Pending decay timeout handles — cleared on rapid successive increments and on unmount.
  const upTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const snap = snapshotStats(agent.spinnerStats, agent.currentStrategy);
      if (snap !== lastSnapshotRef.current) {
        lastSnapshotRef.current = snap;

        const currentUp = agent.spinnerStats?.turnPromptTokens ?? 0;
        const currentDown = agent.spinnerStats?.turnCompletionTokens ?? 0;

        // Pulse the ↑ counter if prompt tokens increased.
        if (currentUp > prevUpRef.current) {
          setUpPulse(true);
          if (upTimeoutRef.current !== null) clearTimeout(upTimeoutRef.current);
          upTimeoutRef.current = setTimeout(() => {
            setUpPulse(false);
            upTimeoutRef.current = null;
          }, PULSE_DECAY_MS);
        }

        // Pulse the ↓ counter if completion tokens increased.
        if (currentDown > prevDownRef.current) {
          setDownPulse(true);
          if (downTimeoutRef.current !== null) clearTimeout(downTimeoutRef.current);
          downTimeoutRef.current = setTimeout(() => {
            setDownPulse(false);
            downTimeoutRef.current = null;
          }, PULSE_DECAY_MS);
        }

        prevUpRef.current = currentUp;
        prevDownRef.current = currentDown;

        force((n) => n + 1);
      }
    }, 500);
    return () => {
      clearInterval(id);
      if (upTimeoutRef.current !== null) {
        clearTimeout(upTimeoutRef.current);
        upTimeoutRef.current = null;
        setUpPulse(false);
      }
      if (downTimeoutRef.current !== null) {
        clearTimeout(downTimeoutRef.current);
        downTimeoutRef.current = null;
        setDownPulse(false);
      }
    };
  }, [agent]);

  const stats: SpinnerStats | null = agent.spinnerStats;
  const strategy = agent.currentStrategy;
  if (!stats && !strategy) return null;

  const up = stats ? formatTokenCount(stats.turnPromptTokens) : '0';
  const down = stats ? formatTokenCount(stats.turnCompletionTokens) : '0';
  // Estimated turn cost (#258) and cumulative session cost. Both always shown —
  // the cells never disappear (they'd otherwise pop in/out and shift the bar).
  // Routed through `formatAggCost` (the same convention `/usage` and `bernard
  // usage` use) so a model the catalog can't price renders `n/a` instead of a
  // confident `~$0.00`. The old `$0.00` masked an entire provider silently
  // dropping out of the catalog.
  const turnReport = stats ? computeTurnUsageReport(stats) : null;
  const turnCost = turnReport
    ? formatAggCost(turnReport.totalCostUsd ?? 0, turnReport.partial)
    : '';
  const sessionCost = formatAggCost(stats?.sessionCostUsd ?? 0, stats?.sessionCostPartial ?? false);
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

  // Each readout is its own group; groups are joined by the same `  ·  ` dot
  // divider the left HintBar uses, and every group leads with an accent-colored
  // label (mirroring the accent keys on the left) so the labels stand out from
  // the muted values. The token readout + context gauge only render once real
  // token stats exist — before the first stats flush (strategy set, stats still
  // null) an all-empty bar would be visual noise. `turn` is the per-turn
  // odometer (full turn cost — main agent plus any sub-agents / wrappers / PAC
  // it spawns — reset each turn); `ctx` is the current main-agent input size
  // (latest step's prompt tokens) — the number the gauge actually depicts.
  const groups: ReactNode[] = [];

  if (strategy) {
    groups.push(
      <Text key="strategy" color={strategy === 'react' ? colors.accent : colors.muted}>
        {strategy === 'react' ? '◆ coordinator' : '◇ normal'}
      </Text>,
    );
  }

  if (stats) {
    // Each readout is a shared HintEntry (accent label + muted value), so the
    // right bar reads with the same grammar as the left HintBar. The values are
    // composite — the ↑/↓ counters pulse to accent, and the ctx gauge dots keep
    // their fill color — because nested Text overrides HintEntry's muted default.
    groups.push(
      <HintEntry
        key="turn"
        hintKey="turn"
        label={
          <>
            <Text color={upPulse ? colors.accent : colors.muted} bold={upPulse}>
              {up}↑
            </Text>{' '}
            <Text color={downPulse ? colors.accent : colors.muted} bold={downPulse}>
              {down}↓
            </Text>{' '}
            {turnCost}
          </>
        }
      />,
      <HintEntry key="session" hintKey="session" label={sessionCost} />,
      <HintEntry
        key="ctx"
        hintKey="ctx"
        label={
          <>
            {formatTokenCount(stats.latestPromptTokens)}{' '}
            {filledCount > 0 && <Text color={fillColor}>{'●'.repeat(filledCount)}</Text>}
            {halfCount > 0 && <Text color={fillColor}>◐</Text>}
            {emptyCount > 0 && (
              <Text color={colors.muted} dimColor>
                {'○'.repeat(emptyCount)}
              </Text>
            )}
          </>
        }
      />,
    );
  }

  const withDividers: ReactNode[] = [];
  groups.forEach((group, i) => {
    if (i > 0) {
      withDividers.push(<HintDivider key={`div${i}`} />);
    }
    withDividers.push(group);
  });

  return <Box justifyContent="flex-end">{withDividers}</Box>;
}
