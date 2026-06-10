import { useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { Agent } from '../../agent.js';
import type { TurnProvenance, SourceItem } from '../../provenance.js';
import { getThemeColors, type ThemeColors } from '../../theme.js';
import { truncate } from '../../text.js';
import { ViewerShell, viewerViewport, type OverlayLine } from './ViewerShell.js';
import { VIEWER_TABS } from './viewer-tabs.js';

interface SourcesViewerProps {
  agent: Agent;
  onClose?: () => void;
  onCycleTab?: () => void;
}

/**
 * Accordion citation history (issue #211). Each turn is a collapsible row:
 * collapsed by default into a one-line header so the whole conversation reads
 * as a clean, scannable list; the focused turn expands (Enter/Space) to show
 * its sources. `↑/↓` moves the cursor; the view auto-scrolls to keep the
 * focused turn visible. Esc / Shift-Tab are owned by the surrounding
 * `ViewerShell`.
 */
export function SourcesViewer({ agent, onClose, onCycleTab }: SourcesViewerProps) {
  const colors = getThemeColors();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const viewport = viewerViewport(rows, VIEWER_TABS.length);
  const turns = agent.getTurnProvenance();

  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [offset, setOffset] = useState(0);

  const { lines, headerLineByTurn } = useMemo(
    () => buildAccordion(turns, expanded, selected, colors, cols),
    [turns.length, expanded, selected, colors, cols],
  );

  const maxOffset = Math.max(0, lines.length - viewport);
  const clamped = Math.min(offset, maxOffset);

  // Re-aim the scroll so turn `sel` (under `exp`) stays visible after a move.
  const scrollTo = (sel: number, exp: Set<number>) => {
    const meta = buildAccordion(turns, exp, sel, colors, cols);
    const total = meta.lines.length;
    const start = meta.headerLineByTurn[sel] ?? 0;
    const end = meta.headerLineByTurn[sel + 1] ?? total; // exclusive
    const maxOff = Math.max(0, total - viewport);
    setOffset((off) => {
      const o = Math.min(off, maxOff);
      const fits = start >= o && end - 1 < o + viewport;
      return fits ? o : Math.min(maxOff, start);
    });
  };

  const move = (delta: number) => {
    if (turns.length === 0) return;
    const next = Math.max(0, Math.min(turns.length - 1, selected + delta));
    setSelected(next);
    scrollTo(next, expanded);
  };

  const setOpen = (open: boolean) => {
    if (turns.length === 0) return;
    const next = new Set(expanded);
    if (open) next.add(selected);
    else next.delete(selected);
    setExpanded(next);
    scrollTo(selected, next);
  };

  useInput((input, key) => {
    if (turns.length === 0) return;
    if (key.downArrow || input === 'j') move(1);
    else if (key.upArrow || input === 'k') move(-1);
    else if (input === 'g') move(-turns.length);
    else if (input === 'G') move(turns.length);
    else if (key.rightArrow) setOpen(true);
    else if (key.leftArrow) setOpen(false);
    else if (key.return || input === ' ') setOpen(!expanded.has(selected));
  });

  const visible = lines.slice(clamped, clamped + viewport);
  const position =
    lines.length > viewport
      ? { first: clamped + 1, last: Math.min(lines.length, clamped + viewport), total: lines.length }
      : null;

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

/**
 * Flattens the turns into single-row lines for the accordion. Returns the line
 * list plus the line index of each turn's header (for scroll math). Only the
 * turns in `expanded` contribute source rows; `selected` only drives the header
 * highlight, so line positions depend on `expanded` alone.
 */
function buildAccordion(
  turns: TurnProvenance[],
  expanded: Set<number>,
  selected: number,
  colors: ThemeColors,
  cols: number,
): { lines: OverlayLine[]; headerLineByTurn: number[] } {
  if (turns.length === 0) {
    return {
      lines: [{ key: 'empty', node: <Text dimColor>No citations recorded yet.</Text> }],
      headerLineByTurn: [],
    };
  }
  const lines: OverlayLine[] = [];
  const headerLineByTurn: number[] = [];
  turns.forEach((turn, i) => {
    const isOpen = expanded.has(i);
    const isSel = i === selected;
    headerLineByTurn[i] = lines.length;
    const count = `${turn.sources.length} source${turn.sources.length === 1 ? '' : 's'}`;
    lines.push({
      key: `turn-${i}`,
      node: (
        <Text
          color={isSel ? colors.accent : undefined}
          bold={isSel}
          dimColor={!isSel}
          wrap="truncate-end"
        >
          {isOpen ? '▾' : '▸'} Turn {turn.turnIndex + 1} · {turn.userInput} ({count})
        </Text>
      ),
    });
    if (!isOpen) return;
    if (turn.sources.length === 0) {
      lines.push({
        key: `turn-${i}-empty`,
        node: (
          <Box marginLeft={5}>
            <Text dimColor>(no sources registered)</Text>
          </Box>
        ),
      });
    } else {
      const citedSet = new Set(turn.citedIds);
      turn.sources.forEach((src, si) => {
        pushSourceLines(lines, `turn-${i}-src-${si}`, src, citedSet.has(src.id), colors, cols);
      });
    }
    lines.push({ key: `turn-${i}-gap`, node: <Text> </Text> });
  });
  return { lines, headerLineByTurn };
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
      <Box marginLeft={5}>
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
        <Box marginLeft={10}>
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
        <Box marginLeft={10}>
          <Text dimColor wrap="truncate-end">
            {source.contentPreview.replace(/\s+/g, ' ')}
          </Text>
        </Box>
      ),
    });
  }
}
