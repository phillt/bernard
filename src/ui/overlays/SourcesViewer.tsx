import { Box, Text } from 'ink';
import type { Agent } from '../../agent.js';
import type { TurnProvenance, SourceItem } from '../../provenance.js';
import { getThemeColors } from '../../theme.js';
import { truncate } from '../../text.js';

interface SourcesViewerProps {
  agent: Agent;
}

/**
 * Full-screen per-turn citation list. Consumes `agent.getTurnProvenance()`
 * (wired in Phase A — see `src/provenance.ts:38` for the shape).
 *
 * Accent rule matches the legacy renderer at `src/repl.ts:874`: a source is
 * "cited" when `citedIds.includes(source.id)`. Cited entries render in the
 * theme accent color; uncited entries render dim.
 *
 * Empty state covers two cases (fresh session, and a session where no turn
 * produced citations). Both render the same hint so the user knows the panel
 * is working as designed and not stuck.
 */
export function SourcesViewer({ agent }: SourcesViewerProps) {
  const colors = getThemeColors();
  const turns = agent.getTurnProvenance();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent} bold>
        Sources
      </Text>
      <Text> </Text>
      {turns.length === 0 ? (
        <Text dimColor>No citations recorded yet.</Text>
      ) : (
        turns.map((turn) => <TurnBlock key={turn.turnIndex} turn={turn} />)
      )}
      <Text> </Text>
      <Text dimColor>Esc to close · Shift-Tab to switch tabs</Text>
    </Box>
  );
}

function TurnBlock({ turn }: { turn: TurnProvenance }) {
  const colors = getThemeColors();
  const citedSet = new Set(turn.citedIds);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={colors.muted}>Turn {turn.turnIndex + 1}:</Text>
        <Text> {truncate(turn.userInput, 80)}</Text>
      </Box>
      {turn.sources.length === 0 ? (
        <Box marginLeft={2}>
          <Text dimColor>(no sources registered)</Text>
        </Box>
      ) : (
        turn.sources.map((src) => (
          <SourceRow key={src.id} source={src} cited={citedSet.has(src.id)} />
        ))
      )}
    </Box>
  );
}

function SourceRow({ source, cited }: { source: SourceItem; cited: boolean }) {
  const colors = getThemeColors();
  // Mirrors the legacy renderer at `src/repl.ts:874-885`: cited entries get
  // the accent label + un-dimmed body; uncited entries use plain dimColor
  // (no extra color override, which can over-darken on some themes).
  const showRawRef = source.rawRef && source.rawRef !== source.label;
  const showPreview = !!source.contentPreview;
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color={cited ? colors.accent : undefined} dimColor={!cited} bold={cited}>
          [^{source.id}]
        </Text>
        <Text dimColor> ({source.kind}) </Text>
        <Text dimColor={!cited}>{truncate(source.label, 80)}</Text>
      </Box>
      {showRawRef && (
        <Box marginLeft={4}>
          <Text dimColor>{truncate(source.rawRef, 120)}</Text>
        </Box>
      )}
      {showPreview && (
        <Box marginLeft={4}>
          <Text dimColor>{truncate(source.contentPreview.replace(/\s+/g, ' '), 160)}</Text>
        </Box>
      )}
    </Box>
  );
}
