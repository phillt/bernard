import { Box, Text, useStdout } from 'ink';
import type { Agent } from '../../agent.js';
import type { TurnProvenance, SourceItem } from '../../provenance.js';
import { getThemeColors, type ThemeColors } from '../../theme.js';
import { truncate } from '../../text.js';
import { ViewerShell, viewerViewport, type OverlayLine } from './ViewerShell.js';
import { useAccordion, type AccordionItem } from './AccordionList.js';
import { VIEWER_TABS } from './viewer-tabs.js';

interface SourcesViewerProps {
  agent: Agent;
  onClose?: () => void;
  onCycleTab?: () => void;
}

/**
 * Accordion citation history (issue #211). Each turn is a collapsible row:
 * collapsed by default into a one-line header so the whole conversation reads
 * as a clean, scannable list; the focused turn expands (Enter/Space/→) to show
 * its sources. Navigation + scrolling live in the shared `useAccordion` hook;
 * Esc / Shift-Tab are owned by the surrounding `ViewerShell`.
 */
export function SourcesViewer({ agent, onClose, onCycleTab }: SourcesViewerProps) {
  const colors = getThemeColors();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const viewport = viewerViewport(rows, { tabCount: VIEWER_TABS.length });
  const turns = agent.getTurnProvenance();

  const items = buildItems(turns, colors, cols);
  const { rows: visible, position } = useAccordion({ items, viewport });

  return (
    <ViewerShell
      tabs={VIEWER_TABS}
      activeTab="sources"
      position={position}
      keyHints="↑/↓ move · ↵ expand · ⇧⇥ switch tab · esc close"
      onClose={onClose}
      onCycleTab={onCycleTab}
    >
      {visible.map((line) => (
        <Box key={line.key}>{line.node}</Box>
      ))}
    </ViewerShell>
  );
}

/** One accordion node per turn; its sources become the expandable detail rows. */
function buildItems(turns: TurnProvenance[], colors: ThemeColors, cols: number): AccordionItem[] {
  if (turns.length === 0) {
    return [
      {
        id: 'empty',
        header: () => <Text dimColor>No citations recorded yet.</Text>,
      },
    ];
  }
  return turns.map((turn, i) => {
    const count = `${turn.sources.length} source${turn.sources.length === 1 ? '' : 's'}`;
    return {
      id: `turn-${i}`,
      header: (selected) => (
        <Text color={selected ? colors.accent : undefined} bold={selected} dimColor={!selected} wrap="truncate-end">
          Turn {turn.turnIndex + 1} · {turn.userInput} ({count})
        </Text>
      ),
      detail: buildSourceRows(turn, colors, cols),
    };
  });
}

function buildSourceRows(turn: TurnProvenance, colors: ThemeColors, cols: number): OverlayLine[] {
  if (turn.sources.length === 0) {
    return [{ key: 'empty', node: <Text dimColor>(no sources registered)</Text> }];
  }
  const citedSet = new Set(turn.citedIds);
  const lines: OverlayLine[] = [];
  turn.sources.forEach((src, si) => {
    pushSourceLines(lines, `src-${si}`, src, citedSet.has(src.id), colors, cols);
  });
  return lines;
}

function pushSourceLines(
  lines: OverlayLine[],
  keyBase: string,
  source: SourceItem,
  cited: boolean,
  colors: ThemeColors,
  cols: number,
): void {
  const labelMax = Math.max(10, cols - 24);
  lines.push({
    key: keyBase,
    node: (
      <Box>
        <Text color={cited ? colors.accent : undefined} dimColor={!cited} bold={cited}>
          [^{source.id}]
        </Text>
        <Text dimColor> {source.kind.padEnd(5)} </Text>
        <Text dimColor={!cited} wrap="truncate-end">
          {truncate(source.label, labelMax)}
        </Text>
      </Box>
    ),
  });
  if (source.rawRef && source.rawRef !== source.label) {
    lines.push({
      key: `${keyBase}-ref`,
      node: (
        <Box marginLeft={2}>
          <Text dimColor wrap="truncate-end">
            ↳ {source.rawRef}
          </Text>
        </Box>
      ),
    });
  }
  if (source.contentPreview) {
    lines.push({
      key: `${keyBase}-preview`,
      node: (
        <Box marginLeft={2}>
          <Text dimColor wrap="truncate-end">
            {source.contentPreview.replace(/\s+/g, ' ')}
          </Text>
        </Box>
      ),
    });
  }
}
