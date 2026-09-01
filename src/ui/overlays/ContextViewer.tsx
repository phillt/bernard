import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Agent } from '../../agent.js';
import { useDimensionsCtx } from '../DimensionsContext.js';
import type { TurnContextRecord } from '../../turn-context.js';
import type { ResolvedEntry } from '../../reference-resolver.js';
import type { RAGSearchResult } from '../../rag.js';
import { getThemeColors } from '../../theme.js';
import { truncate } from '../../text.js';
import { getDomain } from '../../domains.js';
import { ViewerShell, viewerViewport } from './ViewerShell.js';
import type { KeyHint } from '../hints.js';
import { MenuRow, MENU_MARKER } from './MenuRow.js';
import { VIEWER_TABS } from './viewer-tabs.js';
import {
  navDelta,
  clamp,
  clampOffset,
  listPosition,
  wrapText,
  openAtNewest,
} from './viewer-util.js';
import {
  KEY,
  HINT_MOVE,
  HINT_SCROLL,
  HINT_SWITCH_TAB,
  HINT_CLOSE,
  HINT_BACK,
  HINT_BACK_TO_LIST,
} from '../hints.js';

interface ContextViewerProps {
  agent: Agent;
  onClose?: () => void;
  onCycleTab?: () => void;
}

/** Width of the `MenuRow` selection gutter (`> ` / `  `). */
const GUTTER = MENU_MARKER.length;

/** One labelled section of a turn's prompt-assembly trail. */
interface Section {
  label: string;
  /** Full body text (word-wrapped + scrolled in the right panel). */
  body: string;
}

/**
 * Two-panel "Prompt & Context" history — a sibling of {@link SourcesViewer}.
 * Level 1 is a scrollable list of turns; Enter/→ drills into a split panel: the
 * turn's sections on the left (Original input, Rewritten prompt, Resolved
 * references, Recalled facts), the highlighted section's full text on the right
 * (scrollable when it overflows).
 *
 * Shows what the pre-turn pipeline actually fed the agent — the input the user
 * typed vs. the rewritten prompt the model received, the entities resolved, and
 * the memory facts recalled. Deliberately excludes the system prompt (internal
 * infra, not for disk/UI).
 */
export function ContextViewer({ agent, onClose, onCycleTab }: ContextViewerProps) {
  const colors = getThemeColors();
  const { columns: cols, rows } = useDimensionsCtx();
  const viewport = viewerViewport(rows, { tabCount: VIEWER_TABS.length });
  // Immutable during viewer interaction — memoize so cursor/scroll re-renders
  // don't re-copy the records on every keypress.
  const turns = useMemo(() => agent.getTurnContext(), [agent]);

  const [drilled, setDrilled] = useState(false);
  // Recent-first (#248) — the same seed, from the same helper, as
  // `SourcesViewer`. See `openAtNewest` for why the offset is derived rather
  // than left at 0, and the `SourcesViewer` header for why neither viewer
  // auto-drills on open.
  const firstTurn = openAtNewest(turns.length, viewport);
  const [turnCursor, setTurnCursor] = useState(firstTurn.cursor);
  const [turnOffset, setTurnOffset] = useState(firstTurn.offset);
  const [secCursor, setSecCursor] = useState(0);
  const [secOffset, setSecOffset] = useState(0);
  // When drilled in: 'list' navigates sections, 'content' scrolls the body.
  const [focus, setFocus] = useState<'list' | 'content'>('list');
  const [contentOffset, setContentOffset] = useState(0);

  // The drilled turn is always the one under the cursor. If it's somehow
  // missing (e.g. the record set shrank), fall back to the list rather than
  // dereferencing undefined.
  const drilledTurn = drilled ? turns[turnCursor] : undefined;
  const atList = drilledTurn === undefined;
  const sections = useMemo(() => (drilledTurn ? buildSections(drilledTurn) : []), [drilledTurn]);

  // --- Split-panel geometry (only meaningful when drilled in) ---
  const usableCols = Math.max(20, cols - 4); // App wraps the overlay in paddingX={2}.
  const leftWidth = clamp(Math.floor(usableCols * 0.34), 20, 34);
  const cardWidth = Math.max(24, usableCols - leftWidth - 2);
  const innerWidth = Math.max(8, cardWidth - 4); // border (2) + paddingX 1 each side (2).
  // One row is reserved above the panels for the turn header line.
  const bodyRows = Math.max(1, viewport - 1);
  const innerHeight = Math.max(1, bodyRows - 2); // card border top + bottom.

  const selected = sections[secCursor];
  // Memoized so scrolling the content panel doesn't re-wrap the whole body.
  const lines = useMemo(
    () => (selected ? wrapText(selected.body || '(empty)', innerWidth) : []),
    [selected?.label, selected?.body, innerWidth],
  );
  const contentOverflows = lines.length > innerHeight;
  const previewBudget = contentOverflows ? Math.max(1, innerHeight - 1) : innerHeight;
  const maxContentOffset = Math.max(0, lines.length - previewBudget);
  const clampedContentOffset = clamp(contentOffset, 0, maxContentOffset);

  // --- Level 1: turn list navigation ---
  useInput(
    (input, key) => {
      if (turns.length === 0) return;
      const delta = navDelta(input, key, viewport, turns.length);
      if (delta !== null) return void moveTurn(delta);
      if (key.return || key.rightArrow) {
        setDrilled(true);
        setSecCursor(0);
        setSecOffset(0);
        setFocus('list');
        setContentOffset(0);
      }
    },
    { isActive: atList },
  );

  // --- Level 2: split-panel (section list + content scroll) navigation ---
  useInput(
    (input, key) => {
      if (focus === 'content') {
        if (key.escape || key.leftArrow) {
          setFocus('list');
          setContentOffset(0);
          return;
        }
        const delta = navDelta(input, key, previewBudget, lines.length);
        if (delta !== null) setContentOffset((o) => clamp(o + delta, 0, maxContentOffset));
        return;
      }
      // focus === 'list'
      if (key.escape || key.leftArrow) {
        setDrilled(false);
        return;
      }
      if (sections.length === 0) return;
      const delta = navDelta(input, key, bodyRows, sections.length);
      if (delta !== null) return void moveSec(delta);
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
  function moveSec(delta: number): void {
    const next = clamp(secCursor + delta, 0, sections.length - 1);
    setSecCursor(next);
    setSecOffset((o) => clampOffset(next, o, bodyRows, sections.length));
    setContentOffset(0); // new section selected → reset its scroll.
  }

  if (atList) {
    const position = listPosition(turnOffset, viewport, turns.length);
    return (
      <ViewerShell
        tabs={VIEWER_TABS}
        activeTab="context"
        position={position}
        keyHints={[HINT_MOVE, { key: KEY.enter, label: 'open' }, HINT_SWITCH_TAB, HINT_CLOSE]}
        onClose={onClose}
        onCycleTab={onCycleTab}
      >
        {turns.length === 0 ? (
          <Text dimColor>No prompt/context recorded yet.</Text>
        ) : (
          turns.slice(turnOffset, turnOffset + viewport).map((turn, i) => {
            const idx = turnOffset + i;
            const rewritten = turn.rewrittenInput !== turn.originalInput;
            const trailing = rewritten ? ' (rewritten)' : '';
            const budget = Math.max(10, usableCols - GUTTER - trailing.length);
            return (
              <MenuRow
                key={`turn-${idx}`}
                selected={idx === turnCursor}
                label={truncate(`Turn ${turn.turnIndex + 1} · ${turn.originalInput}`, budget)}
                trailing={trailing || undefined}
              />
            );
          })
        )}
      </ViewerShell>
    );
  }

  // Drilled in: `atList` is false only when `drilledTurn` is defined.
  const turn = drilledTurn;
  const position =
    focus === 'content'
      ? {
          first: clampedContentOffset + 1,
          last: Math.min(lines.length, clampedContentOffset + previewBudget),
          total: lines.length,
        }
      : listPosition(secOffset, bodyRows, sections.length);
  const keyHints: KeyHint[] =
    focus === 'content'
      ? [HINT_SCROLL, HINT_BACK_TO_LIST, HINT_SWITCH_TAB]
      : [
          HINT_MOVE,
          ...(contentOverflows ? [{ key: '→', label: 'read' }] : []),
          HINT_BACK,
          HINT_SWITCH_TAB,
        ];

  return (
    <ViewerShell
      tabs={VIEWER_TABS}
      activeTab="context"
      position={position}
      keyHints={keyHints}
      onClose={onClose}
      onCycleTab={onCycleTab}
      escClosesViewer={false}
    >
      <Text dimColor wrap="truncate-end">
        Turn {turn.turnIndex + 1} · {turn.originalInput}
      </Text>
      <Box flexDirection="row">
        <Box flexDirection="column" marginRight={2} width={leftWidth}>
          {sections.slice(secOffset, secOffset + bodyRows).map((sec, i) => {
            const idx = secOffset + i;
            const budget = Math.max(6, leftWidth - GUTTER);
            return (
              <MenuRow
                key={sec.label}
                selected={idx === secCursor && focus === 'list'}
                label={truncate(sec.label, budget)}
              />
            );
          })}
        </Box>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={focus === 'content' ? colors.accent : colors.muted}
          paddingX={1}
          width={cardWidth}
        >
          {lines
            .slice(clampedContentOffset, clampedContentOffset + previewBudget)
            .map((line, i) => (
              <Text key={`p-${i}`}>{line || ' '}</Text>
            ))}
          {contentOverflows && (
            <Text dimColor>
              ↕ lines {clampedContentOffset + 1}–
              {Math.min(lines.length, clampedContentOffset + previewBudget)} of {lines.length}
              {focus === 'list' ? ' (→ to scroll)' : ''}
            </Text>
          )}
        </Box>
      </Box>
    </ViewerShell>
  );
}

/** Build the labelled sections for one turn's prompt-assembly trail. */
function buildSections(turn: TurnContextRecord): Section[] {
  const rewrittenBody =
    turn.rewrittenInput === turn.originalInput
      ? '(unchanged — the rewriter left the input as-is)'
      : turn.rewrittenInput;

  // Guard the array elements defensively: the arrays come off disk, and a
  // partial/hand-edited record could carry a null or malformed entry that would
  // otherwise crash the whole Ink tree on render.
  const refs = turn.resolvedReferences.filter(
    (r): r is ResolvedEntry => !!r && typeof r === 'object',
  );
  const facts = turn.recalledFacts.filter(
    (f): f is RAGSearchResult => !!f && typeof f === 'object',
  );

  const refsBody =
    refs.length === 0
      ? '(no references resolved this turn)'
      : refs.map((r) => `"${r.phrase}" → ${r.resolvedTo}   [${r.sourceKey}]`).join('\n');

  const factsBody =
    facts.length === 0
      ? '(no memory facts recalled this turn)'
      : facts
          .map(
            (f) =>
              `• [${getDomain(f.domain).name}] ${f.fact} (sim ${Number(f.similarity).toFixed(2)})`,
          )
          .join('\n');

  // Injected persistent memory (#307). `undefined` (record predates the field)
  // must not read as "nothing was injected" — branching once on that keeps the
  // count-present-iff-recorded invariant structural rather than coincidental.
  const memKeys = turn.injectedMemoryKeys;
  const memSection: Section =
    memKeys === undefined
      ? { label: 'Persistent memory', body: '(not recorded for this turn)' }
      : {
          label: `Persistent memory (${memKeys.length})`,
          body:
            memKeys.length === 0
              ? '(no persistent memory injected this turn)'
              : memKeys.map((k) => `• ${k}`).join('\n'),
        };

  return [
    { label: 'Original input', body: turn.originalInput },
    { label: 'Rewritten prompt', body: rewrittenBody },
    { label: `Resolved references (${refs.length})`, body: refsBody },
    { label: `Recalled facts (${facts.length})`, body: factsBody },
    memSection,
  ];
}
