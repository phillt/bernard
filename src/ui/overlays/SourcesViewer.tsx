import { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Agent } from '../../agent.js';
import type { TurnProvenance, SourceItem } from '../../provenance.js';
import { getThemeColors, type ThemeColors } from '../../theme.js';
import { truncate } from '../../text.js';
import { ScrollableOverlay, type OverlayLine } from './ScrollableOverlay.js';

interface SourcesViewerProps {
  agent: Agent;
  /** Close the panel (Esc). Defaults to a no-op for standalone rendering/tests. */
  onClose?: () => void;
  /** Advance to the next Shift-Tab tab. Defaults to a no-op. */
  onCycleTab?: () => void;
}

/**
 * Scrollable per-turn citation history (issue #211). Consumes
 * `agent.getTurnProvenance()` — the cumulative array of every turn that
 * registered sources — and flattens it into one visual row per line so the
 * shared `ScrollableOverlay` can window it to the terminal height.
 *
 * Accent rule matches the legacy renderer: a source is "cited" when
 * `citedIds.includes(source.id)`. Cited entries render in the theme accent
 * color; uncited entries render dim. Empty state covers both a fresh session
 * and a session where no turn produced citations.
 */
export function SourcesViewer({ agent, onClose, onCycleTab }: SourcesViewerProps) {
  const colors = getThemeColors();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const turns = agent.getTurnProvenance();
  // The history is immutable while the viewer owns the keystream (the agent is
  // idle), so rebuild the flat line list only when the turn count or width
  // changes — not on every scroll keystroke.
  const lines = useMemo(() => buildLines(turns, colors, cols), [turns.length, colors, cols]);
  return (
    <ScrollableOverlay title="Sources" lines={lines} onClose={onClose} onCycleTab={onCycleTab} />
  );
}

/**
 * Flattens the turn list into single-line rows. Every text value is truncated
 * to fit the terminal width so no row wraps — wrapping would desync the
 * overlay's count-based scroll window.
 */
function buildLines(turns: TurnProvenance[], colors: ThemeColors, cols: number): OverlayLine[] {
  if (turns.length === 0) {
    return [{ key: 'empty', node: <Text dimColor>No citations recorded yet.</Text> }];
  }
  const w = Math.max(20, cols - 4);
  const lines: OverlayLine[] = [];
  turns.forEach((turn, ti) => {
    if (ti > 0) lines.push({ key: `sep-${ti}`, node: <Text> </Text> });
    lines.push({
      key: `turn-${ti}`,
      node: (
        <Box>
          <Text color={colors.muted}>Turn {turn.turnIndex + 1}:</Text>
          <Text> {truncate(turn.userInput, Math.min(80, w - 10))}</Text>
        </Box>
      ),
    });
    if (turn.sources.length === 0) {
      lines.push({
        key: `turn-${ti}-empty`,
        node: (
          <Box marginLeft={2}>
            <Text dimColor>(no sources registered)</Text>
          </Box>
        ),
      });
      return;
    }
    const citedSet = new Set(turn.citedIds);
    turn.sources.forEach((src, si) => {
      pushSourceLines(lines, `turn-${ti}-src-${si}`, src, citedSet.has(src.id), colors, w);
    });
  });
  return lines;
}

function pushSourceLines(
  lines: OverlayLine[],
  keyBase: string,
  source: SourceItem,
  cited: boolean,
  colors: ThemeColors,
  w: number,
): void {
  // Mirrors the legacy SourceRow: cited entries get the accent marker +
  // un-dimmed label; uncited entries render plain dim.
  lines.push({
    key: keyBase,
    node: (
      <Box marginLeft={2}>
        <Text color={cited ? colors.accent : undefined} dimColor={!cited} bold={cited}>
          [^{source.id}]
        </Text>
        <Text dimColor> ({source.kind}) </Text>
        <Text dimColor={!cited}>{truncate(source.label, Math.min(80, w - 16))}</Text>
      </Box>
    ),
  });
  if (source.rawRef && source.rawRef !== source.label) {
    lines.push({
      key: `${keyBase}-ref`,
      node: (
        <Box marginLeft={4}>
          <Text dimColor>{truncate(source.rawRef, Math.min(120, w - 6))}</Text>
        </Box>
      ),
    });
  }
  if (source.contentPreview) {
    lines.push({
      key: `${keyBase}-preview`,
      node: (
        <Box marginLeft={4}>
          <Text dimColor>
            {truncate(source.contentPreview.replace(/\s+/g, ' '), Math.min(160, w - 6))}
          </Text>
        </Box>
      ),
    });
  }
}
