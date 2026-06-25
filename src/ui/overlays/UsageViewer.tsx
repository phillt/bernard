import { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { Agent } from '../../agent.js';
import { formatTokenCount } from '../../output.js';
import { computeTurnUsageReport, formatUsd, type UsageReportRow } from '../../usage-report.js';
import { getThemeColors } from '../../theme.js';
import { truncate } from '../../text.js';
import { ScrollableOverlay, type OverlayLine } from './ScrollableOverlay.js';
import { VIEWER_TABS } from './viewer-tabs.js';

interface UsageViewerProps {
  agent: Agent;
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
export function UsageViewer({ agent, onClose, onCycleTab }: UsageViewerProps) {
  // Stats are stable while the viewer owns the keystream (the agent is idle), so
  // compute the report once rather than on every scroll keystroke.
  const lines = useMemo(() => buildLines(agent), [agent]);
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
      <Text color={labelColor} bold={bold} dimColor={dim}>
        {cell(cells.label, LABEL_W)}
      </Text>
      <Text bold={bold} dimColor={dim}>
        {cell(cells.calls, NUM_W, 'right')}
      </Text>
      <Text bold={bold} dimColor={dim}>
        {cell(cells.tin, NUM_W, 'right')}
      </Text>
      <Text bold={bold} dimColor={dim}>
        {cell(cells.tout, NUM_W, 'right')}
      </Text>
      <Text color={costColor} bold={bold} dimColor={dim}>
        {cell(cells.cost, NUM_W + 1, 'right')}
      </Text>
    </Box>
  );
}

function buildLines(agent: Agent): OverlayLine[] {
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
    node: (
      <Row
        cells={{ label: 'TIER / MODEL', calls: 'calls', tin: 'in', tout: 'out', cost: '~cost' }}
        bold
        dim
      />
    ),
  });

  for (const row of report.rows) {
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
      node: (
        <Text dimColor>n/a = no catalog pricing (custom provider); total omits those rows.</Text>
      ),
    });
  }
  lines.push({
    key: 'estimate-note',
    node: (
      <Text dimColor>
        Cost is an estimate; caching, batch, and reasoning-token pricing may differ.
      </Text>
    ),
  });

  return lines;
}

function rowKey(row: UsageReportRow): string {
  return `row-${row.bucket}-${row.provider}-${row.modelName}`;
}

function UsageRow({
  row,
  colors,
}: {
  row: UsageReportRow;
  colors: ReturnType<typeof getThemeColors>;
}) {
  const tierColor =
    row.bucket === 'premium'
      ? colors.accent
      : row.bucket === 'pinned'
        ? colors.warning
        : colors.text;
  return (
    <Row
      cells={{
        label: `${row.bucket.padEnd(7)} ${row.modelName}`,
        calls: String(row.calls),
        tin: formatTokenCount(row.promptTokens),
        tout: formatTokenCount(row.completionTokens),
        cost: row.costUsd === null ? 'n/a' : `~${formatUsd(row.costUsd)}`,
      }}
      labelColor={tierColor}
      costColor={row.costUsd === null ? colors.muted : colors.text}
    />
  );
}
