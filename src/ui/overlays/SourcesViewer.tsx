import { useMemo, useState, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Agent } from '../../agent.js';
import { useDimensionsCtx } from '../DimensionsContext.js';
import type { SourceItem } from '../../provenance.js';
import { getThemeColors, type ThemeColors } from '../../theme.js';
import { truncate } from '../../text.js';
import { ViewerShell, viewerViewport } from './ViewerShell.js';
import { MenuRow, MENU_MARKER } from './MenuRow.js';
import { VIEWER_TABS } from './viewer-tabs.js';
import { navDelta, clamp, clampOffset, listPosition, wrapText } from './viewer-util.js';

interface SourcesViewerProps {
  agent: Agent;
  onClose?: () => void;
  onCycleTab?: () => void;
}

/** Width of the `MenuRow` selection gutter (`> ` / `  `). */
const GUTTER = MENU_MARKER.length;

/**
 * Two-panel citation history (issue #211 redesign). Level 1 is a scrollable
 * list of turns; pressing Enter/→ on a turn drills into a split panel: the
 * turn's citations on the left (cited first), a human-friendly render of the
 * highlighted citation's content on the right (the same left-list + detail-card
 * shape as the lineup role picker).
 *
 * Navigation has three focus states, each owned by an `isActive`-gated
 * `useInput`:
 *   - turn list  (`drillTarget === null`)            — ↑/↓ move, Enter/→ drill.
 *   - citation list (`drillTarget !== null`, list)   — ↑/↓ move the highlight,
 *     Enter/→ focuses the content panel when it overflows, Esc/← back to turns.
 *   - content    (`drillTarget !== null`, content)   — ↑/↓ scroll the right
 *     panel so long excerpts are fully readable, Esc/← back to the citations.
 *
 * Every row is clamped to a single terminal line and every panel is clamped to
 * the live viewport height, so the frame can never exceed the terminal (which
 * previously made the list look endless and the right card render blank).
 *
 * The shell owns Shift-Tab always and Esc only at the turn list
 * (`escClosesViewer`); the inner handlers own Esc everywhere deeper.
 */
export function SourcesViewer({ agent, onClose, onCycleTab }: SourcesViewerProps) {
  const colors = getThemeColors();
  const { columns: cols, rows } = useDimensionsCtx();
  const viewport = viewerViewport(rows, { tabCount: VIEWER_TABS.length });
  const turns = agent.getTurnProvenance();

  // `null` = turn list; a number = the index into `turns` we've drilled into.
  const [drillTarget, setDrillTarget] = useState<number | null>(null);
  const [turnCursor, setTurnCursor] = useState(0);
  const [turnOffset, setTurnOffset] = useState(0);
  const [srcCursor, setSrcCursor] = useState(0);
  const [srcOffset, setSrcOffset] = useState(0);
  // When drilled in: 'list' navigates citations, 'content' scrolls the card.
  const [focus, setFocus] = useState<'list' | 'content'>('list');
  const [contentOffset, setContentOffset] = useState(0);

  const atList = drillTarget === null;
  const drilledTurn = atList ? null : turns[drillTarget];
  const citedSet = new Set(drilledTurn?.citedIds ?? []);
  // Cited sources first, then uncited; `sort` is stable so within-group order
  // (registration order) is preserved.
  const sources = atList
    ? []
    : [...(drilledTurn?.sources ?? [])].sort(
        (a, b) => (citedSet.has(b.id) ? 1 : 0) - (citedSet.has(a.id) ? 1 : 0),
      );

  // --- Split-panel geometry (only meaningful when drilled in) ---
  const usableCols = Math.max(20, cols - 4); // App wraps the overlay in paddingX={2}.
  const leftWidth = clamp(Math.floor(usableCols * 0.42), 24, 44);
  const cardWidth = Math.max(24, usableCols - leftWidth - 2);
  const innerWidth = Math.max(8, cardWidth - 4); // border (2) + paddingX 1 each side (2).
  // One row is reserved above the panels for the turn header line.
  const bodyRows = Math.max(1, viewport - 1);
  const innerHeight = Math.max(1, bodyRows - 2); // card border top + bottom.

  const selected = sources[srcCursor];
  const selectedCited = selected ? citedSet.has(selected.id) : false;
  // Memoized so scrolling the content panel (a keypress that doesn't change the
  // selection) doesn't re-run the regex + JSON.parse + word-wrap over the whole
  // preview. `colors` is a stable reference from the theme registry.
  const detail = useMemo(
    () => (selected ? buildCitationDetail(selected, selectedCited, innerWidth, colors) : null),
    [selected?.id, selectedCited, innerWidth, colors],
  );
  // Clamp the header so a tall header (e.g. a 3-line wrapped title) on a short
  // terminal can't push the card past the viewport — always leave room for at
  // least one preview line plus the overflow hint.
  const headerShown = detail ? detail.header.slice(0, Math.max(1, innerHeight - 2)) : [];
  const maxPreviewLines = detail ? Math.max(1, innerHeight - headerShown.length) : 1;
  const contentOverflows = detail ? detail.lines.length > maxPreviewLines : false;
  // Reserve a row for the position hint when the excerpt overflows.
  const previewBudget = contentOverflows ? Math.max(1, maxPreviewLines - 1) : maxPreviewLines;
  const maxContentOffset = detail ? Math.max(0, detail.lines.length - previewBudget) : 0;
  const clampedContentOffset = clamp(contentOffset, 0, maxContentOffset);

  // --- Level 1: turn list navigation ---
  useInput(
    (input, key) => {
      if (turns.length === 0) return;
      const delta = navDelta(input, key, viewport, turns.length);
      if (delta !== null) return void moveTurn(delta);
      if (key.return || key.rightArrow) {
        setDrillTarget(turnCursor);
        setSrcCursor(0);
        setSrcOffset(0);
        setFocus('list');
        setContentOffset(0);
      }
    },
    { isActive: atList },
  );

  // --- Level 2: split-panel (citation list + content scroll) navigation ---
  useInput(
    (input, key) => {
      if (focus === 'content') {
        if (key.escape || key.leftArrow) {
          setFocus('list');
          setContentOffset(0);
          return;
        }
        const delta = navDelta(input, key, previewBudget, detail?.lines.length ?? 0);
        if (delta !== null) setContentOffset((o) => clamp(o + delta, 0, maxContentOffset));
        return;
      }
      // focus === 'list'
      if (key.escape || key.leftArrow) {
        setDrillTarget(null);
        return;
      }
      if (sources.length === 0) return;
      const delta = navDelta(input, key, bodyRows, sources.length);
      if (delta !== null) return void moveSrc(delta);
      if ((key.return || key.rightArrow) && contentOverflows) {
        setFocus('content');
        setContentOffset(0);
      }
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
    setSrcOffset((o) => clampOffset(next, o, bodyRows, sources.length));
    setContentOffset(0); // new citation selected → reset its scroll.
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
          turns.slice(turnOffset, turnOffset + viewport).map((turn, i) => {
            const idx = turnOffset + i;
            const count = `${turn.sources.length} source${turn.sources.length === 1 ? '' : 's'}`;
            const trailing = ` (${count})`;
            const budget = Math.max(10, usableCols - GUTTER - trailing.length);
            return (
              <MenuRow
                key={`turn-${idx}`}
                selected={idx === turnCursor}
                label={truncate(`Turn ${turn.turnIndex + 1} · ${turn.userInput}`, budget)}
                trailing={trailing}
              />
            );
          })
        )}
      </ViewerShell>
    );
  }

  // Drilled in: `drillTarget` is a valid index, so the turn is non-null.
  const turn = drilledTurn!;
  const position =
    focus === 'content' && detail
      ? {
          first: clampedContentOffset + 1,
          last: Math.min(detail.lines.length, clampedContentOffset + previewBudget),
          total: detail.lines.length,
        }
      : listPosition(srcOffset, bodyRows, sources.length);
  const readHint = contentOverflows ? ' · → read' : '';
  const keyHints =
    focus === 'content'
      ? '↑/↓ scroll · esc/← back to list · ⇧⇥ switch tab'
      : `↑/↓ move${readHint} · esc/← back · ⇧⇥ switch tab`;

  return (
    <ViewerShell
      tabs={VIEWER_TABS}
      activeTab="sources"
      position={position}
      keyHints={keyHints}
      onClose={onClose}
      onCycleTab={onCycleTab}
      escClosesViewer={false}
    >
      <Text dimColor wrap="truncate-end">
        Turn {turn.turnIndex + 1} · {turn.userInput}
      </Text>
      <Box flexDirection="row">
        <Box flexDirection="column" marginRight={2} width={leftWidth}>
          {sources.length === 0 ? (
            <Text dimColor>(no sources registered)</Text>
          ) : (
            sources.slice(srcOffset, srcOffset + bodyRows).map((src, i) => {
              const idx = srcOffset + i;
              const tick = citedSet.has(src.id) ? ' ✓' : '';
              // Clamp the whole composed row to one terminal line so the list
              // windowing stays honest and the frame never overflows.
              const budget = Math.max(6, leftWidth - GUTTER - 2);
              const label = truncate(`[^${src.id}] ${src.kind} ${src.label}`, budget);
              return (
                <MenuRow
                  key={src.id}
                  selected={idx === srcCursor && focus === 'list'}
                  label={label}
                  trailing={tick || undefined}
                />
              );
            })
          )}
        </Box>
        {detail && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={focus === 'content' ? colors.accent : colors.muted}
            paddingX={1}
            width={cardWidth}
          >
            {headerShown}
            {detail.lines
              .slice(clampedContentOffset, clampedContentOffset + previewBudget)
              .map((line, i) => (
                <Text key={`p-${i}`} dimColor={!selected!.contentPreview}>
                  {line || ' '}
                </Text>
              ))}
            {contentOverflows && (
              <Text dimColor>
                ↕ lines {clampedContentOffset + 1}–
                {Math.min(detail.lines.length, clampedContentOffset + previewBudget)} of{' '}
                {detail.lines.length}
                {focus === 'list' ? ' (→ to scroll)' : ''}
              </Text>
            )}
          </Box>
        )}
      </Box>
    </ViewerShell>
  );
}

/** Cap on how many wrapped lines the title may occupy before it truncates. */
const MAX_TITLE_LINES = 3;

/**
 * Build the right-hand detail card body for a single citation: a header block
 * (title, kind + cited status, the actionable `rawRef`) plus the word-wrapped
 * content lines. Splitting "build" from "render" lets the caller window `lines`
 * to the available height and lets the navigation handler clamp the scroll
 * offset against the real wrapped-line count.
 */
function buildCitationDetail(
  source: SourceItem,
  cited: boolean,
  innerWidth: number,
  colors: ThemeColors,
): { header: ReactNode[]; lines: string[] } {
  const w = Math.max(8, innerWidth);

  // Wrap the title onto new lines rather than cutting it off with an ellipsis.
  // Each wrapped line is exactly one terminal row, so the height math (which
  // counts header nodes) stays honest.
  const titleLines = wrapText(source.label, w);
  if (titleLines.length > MAX_TITLE_LINES) {
    titleLines.length = MAX_TITLE_LINES;
    titleLines[MAX_TITLE_LINES - 1] = truncate(titleLines[MAX_TITLE_LINES - 1] + '…', w);
  }

  const header: ReactNode[] = [
    ...titleLines.map((line, i) => (
      <Text key={`title-${i}`} color={colors.accent} bold>
        {line}
      </Text>
    )),
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

  const lines = source.contentPreview
    ? wrapText(humanizeContent(source.contentPreview), w)
    : ['(no content preview)'];
  return { header, lines };
}

/**
 * Make machine-y content human-readable. Tool-result previews are typically
 * `<tool>: <json>` — detect the embedded JSON, parse it, and render it as an
 * aligned key/value table (flat objects) or 2-space-indented JSON (nested /
 * arrays). Falls back to the raw string when there's no JSON or the preview was
 * truncated mid-object (so it won't parse).
 */
function humanizeContent(content: string): string {
  const m = content.match(/^([A-Za-z0-9_.\- ]{1,40}?):\s*([[{][\s\S]*)$/);
  const prefix = m ? m[1].trim() : null;
  const body = (m ? m[2] : content).trim();
  if (body[0] === '{' || body[0] === '[') {
    const cleaned = body.replace(/[\s…]*$/, ''); // drop a trailing ellipsis from truncation.
    const parsed = tryParseJson(cleaned);
    if (parsed !== undefined) {
      const rendered = renderJsonValue(parsed);
      return prefix ? `${prefix}:\n${rendered}` : rendered;
    }
  }
  return content;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Aligned key/value lines for a flat object; pretty-printed JSON otherwise. */
function renderJsonValue(v: unknown): string {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const entries = Object.entries(v as Record<string, unknown>);
    const allScalar =
      entries.length > 0 && entries.every(([, val]) => val === null || typeof val !== 'object');
    if (allScalar) {
      const keyW = Math.min(18, Math.max(...entries.map(([k]) => k.length)));
      return entries.map(([k, val]) => `${k.padEnd(keyW)}  ${scalarString(val)}`).join('\n');
    }
  }
  return JSON.stringify(v, null, 2);
}

function scalarString(v: unknown): string {
  if (v === null) return 'null';
  return typeof v === 'string' ? v : String(v);
}


