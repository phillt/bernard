import { useState, type ReactNode } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { Agent } from '../../agent.js';
import type { SourceItem } from '../../provenance.js';
import { getThemeColors, type ThemeColors } from '../../theme.js';
import { truncate } from '../../text.js';
import { ViewerShell, viewerViewport } from './ViewerShell.js';
import { MenuRow } from './MenuRow.js';
import { VIEWER_TABS } from './viewer-tabs.js';

interface SourcesViewerProps {
  agent: Agent;
  onClose?: () => void;
  onCycleTab?: () => void;
}

/**
 * Two-panel citation history (issue #211 redesign). Level 1 is a scrollable
 * list of turns; pressing Enter/→ on a turn drills into a split panel: the
 * turn's citations on the left, a human-friendly render of the highlighted
 * citation's content on the right (the same left-list + detail-card shape as
 * the lineup role picker). Esc/← steps back to the turn list; a second Esc (at
 * the turn list) closes the viewer. Shift-Tab cycles tabs at either level.
 *
 * Navigation is owned here via two `isActive`-gated `useInput`s; the shell owns
 * Shift-Tab always and Esc only at the turn list (`escClosesViewer`).
 */
export function SourcesViewer({ agent, onClose, onCycleTab }: SourcesViewerProps) {
  const colors = getThemeColors();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const viewport = viewerViewport(rows, { tabCount: VIEWER_TABS.length });
  const turns = agent.getTurnProvenance();

  // `null` = turn list; a number = the index into `turns` we've drilled into.
  const [drillTarget, setDrillTarget] = useState<number | null>(null);
  const [turnCursor, setTurnCursor] = useState(0);
  const [turnOffset, setTurnOffset] = useState(0);
  const [srcCursor, setSrcCursor] = useState(0);
  const [srcOffset, setSrcOffset] = useState(0);

  const atList = drillTarget === null;
  const drilledTurn = atList ? null : turns[drillTarget];
  const sources = drilledTurn?.sources ?? [];

  // --- Level 1: turn list navigation ---
  useInput(
    (input, key) => {
      if (turns.length === 0) return;
      if (key.downArrow || input === 'j') moveTurn(1);
      else if (key.upArrow || input === 'k') moveTurn(-1);
      else if (key.pageDown) moveTurn(viewport);
      else if (key.pageUp) moveTurn(-viewport);
      else if (input === 'g') moveTurn(-turns.length);
      else if (input === 'G') moveTurn(turns.length);
      else if (key.return || key.rightArrow) {
        setDrillTarget(turnCursor);
        setSrcCursor(0);
        setSrcOffset(0);
      }
    },
    { isActive: atList },
  );

  // --- Level 2: split-panel (citation) navigation ---
  useInput(
    (input, key) => {
      if (key.escape || key.leftArrow) {
        setDrillTarget(null);
        return;
      }
      if (sources.length === 0) return;
      if (key.downArrow || input === 'j') moveSrc(1);
      else if (key.upArrow || input === 'k') moveSrc(-1);
      else if (key.pageDown) moveSrc(viewport);
      else if (key.pageUp) moveSrc(-viewport);
      else if (input === 'g') moveSrc(-sources.length);
      else if (input === 'G') moveSrc(sources.length);
    },
    { isActive: !atList },
  );

  function moveTurn(delta: number): void {
    const next = clamp(turnCursor + delta, 0, turns.length - 1);
    setTurnCursor(next);
    setTurnOffset((o) => clampOffset(next, o, viewport, turns.length));
  }
  function moveSrc(delta: number): void {
    const next = clamp(srcCursor + delta, 0, sources.length - 1);
    setSrcCursor(next);
    setSrcOffset((o) => clampOffset(next, o, viewport, sources.length));
  }

  if (atList) {
    const position = listPosition(turnOffset, viewport, turns.length);
    return (
      <ViewerShell
        tabs={VIEWER_TABS}
        activeTab="sources"
        position={position}
        keyHints="↑/↓ move · ↵ open · ⇧⇥ switch tab · esc close"
        onClose={onClose}
        onCycleTab={onCycleTab}
      >
        {turns.length === 0 ? (
          <Text dimColor>No citations recorded yet.</Text>
        ) : (
          turns
            .slice(turnOffset, turnOffset + viewport)
            .map((turn, i) => {
              const idx = turnOffset + i;
              const count = `${turn.sources.length} source${turn.sources.length === 1 ? '' : 's'}`;
              return (
                <MenuRow
                  key={`turn-${idx}`}
                  selected={idx === turnCursor}
                  label={truncate(`Turn ${turn.turnIndex + 1} · ${turn.userInput}`, Math.max(10, cols - 18))}
                  trailing={` (${count})`}
                />
              );
            })
        )}
      </ViewerShell>
    );
  }

  // Drilled in. `drilledTurn` is defined here (drillTarget is a valid index).
  const citedSet = new Set(drilledTurn?.citedIds ?? []);
  const selected = sources[srcCursor];
  // App wraps the overlay in paddingX={2}; reserve a left column for the list.
  const usableCols = Math.max(20, cols - 4);
  const leftWidth = clamp(Math.floor(usableCols * 0.42), 24, 44);
  const cardWidth = Math.max(24, usableCols - leftWidth - 2);
  const position = listPosition(srcOffset, viewport, sources.length);

  return (
    <ViewerShell
      tabs={VIEWER_TABS}
      activeTab="sources"
      position={position}
      keyHints="↑/↓ move · esc/← back · ⇧⇥ switch tab"
      onClose={onClose}
      onCycleTab={onCycleTab}
      escClosesViewer={false}
    >
      <Text dimColor wrap="truncate-end">
        Turn {(drilledTurn?.turnIndex ?? 0) + 1} · {drilledTurn?.userInput ?? ''}
      </Text>
      <Box flexDirection="row">
        <Box flexDirection="column" marginRight={2} width={leftWidth}>
          {sources.length === 0 ? (
            <Text dimColor>(no sources registered)</Text>
          ) : (
            sources.slice(srcOffset, srcOffset + viewport).map((src, i) => {
              const idx = srcOffset + i;
              const label = `[^${src.id}] ${src.kind.padEnd(5)} ${truncate(src.label, Math.max(6, leftWidth - 14))}`;
              return (
                <MenuRow
                  key={src.id}
                  selected={idx === srcCursor}
                  label={label}
                  trailing={citedSet.has(src.id) ? ' ✓' : undefined}
                />
              );
            })
          )}
        </Box>
        {selected && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={colors.muted}
            paddingX={1}
            width={cardWidth}
          >
            {renderCitationDetail(selected, citedSet.has(selected.id), cardWidth - 4, viewport - 2, colors)}
          </Box>
        )}
      </Box>
    </ViewerShell>
  );
}

/**
 * Right-hand detail card body for a single citation: title, kind + cited
 * status, the actionable `rawRef`, then a word-wrapped content excerpt clipped
 * to the available height. Returns the nodes inside the bordered card (the card
 * supplies the border + horizontal padding).
 */
function renderCitationDetail(
  source: SourceItem,
  cited: boolean,
  innerWidth: number,
  innerHeight: number,
  colors: ThemeColors,
): ReactNode {
  const w = Math.max(8, innerWidth);
  const header: ReactNode[] = [
    <Text key="title" color={colors.accent} bold wrap="truncate-end">
      {truncate(source.label, w)}
    </Text>,
    <Text key="kind">
      <Text dimColor>{source.kind}</Text>
      <Text color={cited ? colors.success : undefined} dimColor={!cited}>
        {cited ? ' · cited' : ' · not cited'}
      </Text>
    </Text>,
  ];
  if (source.rawRef && source.rawRef !== source.label) {
    header.push(
      <Text key="ref" dimColor wrap="truncate-end">
        ↳ {source.rawRef}
      </Text>,
    );
  }
  header.push(<Text key="gap"> </Text>);

  const previewLines = source.contentPreview ? wrapText(source.contentPreview, w) : ['(no content preview)'];
  // Leave room for the header and a possible "more" hint within the card.
  const budget = Math.max(1, innerHeight - header.length - 1);
  const shown = previewLines.slice(0, budget);
  const hidden = previewLines.length - shown.length;

  return (
    <>
      {header}
      {shown.map((line, i) => (
        <Text key={`p-${i}`} dimColor={!source.contentPreview}>
          {line || ' '}
        </Text>
      ))}
      {hidden > 0 && <Text dimColor>… ({hidden} more line{hidden === 1 ? '' : 's'})</Text>}
    </>
  );
}

/** Greedy word-wrap that preserves paragraph breaks and hard-splits overlong words. */
function wrapText(s: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const para of s.split('\n')) {
    if (para.trim() === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let token = word;
      while (token.length > w) {
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(token.slice(0, w));
        token = token.slice(w);
      }
      if (!line) line = token;
      else if (line.length + 1 + token.length <= w) line += ` ${token}`;
      else {
        out.push(line);
        line = token;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

/** Keep the cursor visible: scroll the window only when it would fall off an edge. */
function clampOffset(cursor: number, offset: number, size: number, total: number): number {
  const maxOffset = Math.max(0, total - size);
  let o = Math.min(offset, maxOffset);
  if (cursor < o) o = cursor;
  else if (cursor >= o + size) o = cursor - size + 1;
  return clamp(o, 0, maxOffset);
}

function listPosition(
  offset: number,
  size: number,
  total: number,
): { first: number; last: number; total: number } | null {
  if (total <= size) return null;
  return { first: offset + 1, last: Math.min(total, offset + size), total };
}
