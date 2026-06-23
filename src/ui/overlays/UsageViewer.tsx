import { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { Agent } from '../../agent.js';
import { formatTokenCount } from '../../output.js';
import { computeTurnUsageReport, fillTierRows, formatUsd, type UsageReportRow } from '../../usage-report.js';
import { LINEUP_TIERS, type LineupTier, type LineupSlot } from '../../lineups.js';
import { DEFAULT_ROLE_TIERS } from '../../model-roles.js';
import type { ModelMode } from '../../model-policy.js';
import { getThemeColors } from '../../theme.js';
import { truncate } from '../../text.js';
import { ScrollableOverlay, type OverlayLine } from './ScrollableOverlay.js';
import { VIEWER_TABS } from './viewer-tabs.js';

interface UsageViewerProps {
  agent: Agent;
  /**
   * Representative `(provider, model)` per cost tier for the active lineup
   * (`representativeTierModels(config)`). When present, the panel always renders
   * all three tiers — appending dimmed zero-rows for tiers with no usage this
   * turn so the high-end tier is visible even in modes that never reach it.
   * Omitted in standalone renders/tests → only used tiers are shown (legacy).
   */
  tierModels?: Record<LineupTier, LineupSlot>;
  /** Active model mode — drives the footer note explaining unused tiers. */
  modelMode?: ModelMode;
  /** Close the panel (Esc). Defaults to a no-op for standalone rendering/tests. */
  onClose?: () => void;
  /** Advance to the next Shift-Tab tab. Defaults to a no-op. */
  onCycleTab?: () => void;
}

// Column widths for the breakdown table. LABEL holds `<tier> <model>`.
const LABEL_W = 34;
const NUM_W = 9;

/**
 * Scrollable "Usage & Cost" panel (#258) — the last turn's token spend broken
 * down by cost tier + model, with an estimated dollar cost per row and a total.
 * Reads the per-turn ledger off `agent.spinnerStats` (persisted until the next
 * turn opens), joins it against catalog pricing via `computeTurnUsageReport`,
 * and renders through the shared `ScrollableOverlay` so it shares the Shift-Tab
 * tab strip + Esc/scroll keystream with the Status / Sources viewers.
 */
export function UsageViewer({ agent, tierModels, modelMode, onClose, onCycleTab }: UsageViewerProps) {
  // Stats are stable while the viewer owns the keystream (the agent is idle), so
  // compute the report once rather than on every scroll keystroke.
  const lines = useMemo(() => buildLines(agent, tierModels, modelMode), [agent, tierModels, modelMode]);
  return (
    <ScrollableOverlay
      tabs={VIEWER_TABS}
      activeTab="usage"
      lines={lines}
      onClose={onClose}
      onCycleTab={onCycleTab}
    />
  );
}

function cell(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  const v = value.length > width ? truncate(value, width) : value;
  return align === 'right' ? v.padStart(width) : v.padEnd(width);
}

interface RowCells {
  label: string;
  calls: string;
  tin: string;
  tout: string;
  cost: string;
}

/**
 * The single 5-column row renderer for the table — used by the header, every
 * data row, and the total — so column widths and alignment live in exactly one
 * place. `labelColor`/`costColor` tint those two cells; `bold`/`dim` style the
 * whole row.
 */
function Row({
  cells,
  labelColor,
  costColor,
  bold,
  dim,
}: {
  cells: RowCells;
  labelColor?: string;
  costColor?: string;
  bold?: boolean;
  dim?: boolean;
}) {
  return (
    <Box>
      <Text color={labelColor} bold={bold} dimColor={dim}>{cell(cells.label, LABEL_W)}</Text>
      <Text bold={bold} dimColor={dim}>{cell(cells.calls, NUM_W, 'right')}</Text>
      <Text bold={bold} dimColor={dim}>{cell(cells.tin, NUM_W, 'right')}</Text>
      <Text bold={bold} dimColor={dim}>{cell(cells.tout, NUM_W, 'right')}</Text>
      <Text color={costColor} bold={bold} dimColor={dim}>{cell(cells.cost, NUM_W + 1, 'right')}</Text>
    </Box>
  );
}

function buildLines(
  agent: Agent,
  tierModels?: Record<LineupTier, LineupSlot>,
  modelMode?: ModelMode,
): OverlayLine[] {
  const colors = getThemeColors();
  const report = computeTurnUsageReport(agent.spinnerStats);
  const lines: OverlayLine[] = [];

  if (report.rows.length === 0) {
    lines.push({
      key: 'empty',
      node: <Text dimColor>No usage recorded yet — send a message first.</Text>,
    });
    return lines;
  }

  lines.push({
    key: 'header',
    node: <Row cells={{ label: 'TIER / MODEL', calls: 'calls', tin: 'in', tout: 'out', cost: '~cost' }} bold dim />,
  });

  // Always show every lineup tier when we know the active lineup's models:
  // zero-fill the tiers that had no traffic so the high-end tier stays visible
  // even in modes that never reach it (e.g. `optimize-tokens` → no premium).
  const displayRows = tierModels ? fillTierRows(report.rows, tierModels) : report.rows;
  for (const row of displayRows) {
    lines.push({ key: rowKey(row), node: <UsageRow row={row} colors={colors} /> });
  }

  // Total row.
  lines.push({
    key: 'total',
    node: (
      <Row
        cells={{
          label: 'TOTAL',
          calls: String(report.totalCalls),
          tin: formatTokenCount(report.totalPromptTokens),
          tout: formatTokenCount(report.totalCompletionTokens),
          cost: report.totalCostUsd === null ? 'n/a' : `~${formatUsd(report.totalCostUsd)}`,
        }}
        bold
      />
    ),
  });

  // Footnotes.
  lines.push({ key: 'spacer', node: <Text> </Text> });
  const tierNote = tierModels ? buildTierNote(displayRows, modelMode) : null;
  if (tierNote) {
    lines.push({ key: 'tier-note', node: <Text dimColor>{tierNote}</Text> });
  }
  if (report.totalCacheReadTokens > 0) {
    lines.push({
      key: 'cache-note',
      node: (
        <Text dimColor>
          {formatTokenCount(report.totalCacheReadTokens)} prompt-cache reads this turn (billed at a
          discount; not reflected in the estimate).
        </Text>
      ),
    });
  }
  if (report.partial) {
    lines.push({
      key: 'partial-note',
      node: <Text dimColor>n/a = no catalog pricing (custom provider); total omits those rows.</Text>,
    });
  }
  lines.push({
    key: 'estimate-note',
    node: <Text dimColor>Cost is an estimate; caching, batch, and reasoning-token pricing may differ.</Text>,
  });

  return lines;
}

function rowKey(row: UsageReportRow): string {
  return `row-${row.bucket}-${row.provider}-${row.modelName}`;
}

/**
 * Footer note explaining the dimmed zero-usage tier rows. Splits the unused
 * tiers into those the active mode *never reaches* (structurally unused — e.g.
 * `premium` under `optimize-tokens`) and those merely idle this turn, so the
 * absence reads as intentional rather than a bug. Returns `null` when every
 * shown tier had traffic.
 */
function buildTierNote(rows: UsageReportRow[], modelMode?: ModelMode): string | null {
  const unused = LINEUP_TIERS.filter((tier) => rows.some((r) => r.bucket === tier && r.calls === 0));
  if (unused.length === 0) return null;

  if (modelMode) {
    const reachable = new Set(Object.values(DEFAULT_ROLE_TIERS[modelMode]));
    const structural = unused.filter((t) => !reachable.has(t));
    const idle = unused.filter((t) => reachable.has(t));
    const parts: string[] = [`Mode: ${modelMode}.`];
    if (structural.length > 0) {
      parts.push(`${structural.join('/')} ${structural.length > 1 ? 'are' : 'is'} not used in this mode.`);
    }
    if (idle.length > 0) {
      parts.push(`${idle.join('/')} had no calls this turn.`);
    }
    return parts.join(' ');
  }
  return `Dimmed tiers (${unused.join('/')}) had no calls this turn.`;
}

function UsageRow({ row, colors }: { row: UsageReportRow; colors: ReturnType<typeof getThemeColors> }) {
  const zero = row.calls === 0;
  const dash = '—';
  const tierColor = zero
    ? colors.muted
    : row.bucket === 'premium'
      ? colors.accent
      : row.bucket === 'pinned'
        ? colors.warning
        : colors.text;
  return (
    <Row
      cells={{
        label: `${row.bucket.padEnd(7)} ${row.modelName}`,
        calls: zero ? dash : String(row.calls),
        tin: zero ? dash : formatTokenCount(row.promptTokens),
        tout: zero ? dash : formatTokenCount(row.completionTokens),
        cost: zero ? dash : row.costUsd === null ? 'n/a' : `~${formatUsd(row.costUsd)}`,
      }}
      labelColor={tierColor}
      costColor={zero ? colors.muted : row.costUsd === null ? colors.muted : colors.text}
      dim={zero}
    />
  );
}
