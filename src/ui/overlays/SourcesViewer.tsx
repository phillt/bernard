import { useMemo, useState, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Agent } from '../../agent.js';
import { useDimensionsCtx } from '../DimensionsContext.js';
import type { SourceItem } from '../../provenance.js';
import { getThemeColors, type ThemeColors } from '../../theme.js';
import { truncate } from '../../text.js';
import { formatElapsed, formatFriendlyTimestamp } from '../../output.js';
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
import { type RichLine, type SpanRole } from './table.js';
import { buildPreviewLines } from './preview-lines.js';
import {
  KEY,
  HINT_MOVE,
  HINT_SCROLL,
  HINT_SWITCH_TAB,
  HINT_CLOSE,
  HINT_BACK,
  HINT_BACK_TO_LIST,
} from '../hints.js';

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
 * The turn list opens on the NEWEST turn (`openAtNewest`, #248). It deliberately
 * does NOT auto-drill into it: the level-1 list is the only place the session's
 * shape is visible, and drilling on open would spend the viewer's first Esc on
 * "back to the list" (`escClosesViewer={false}` while drilled) — so Shift+Tab
 * followed by Esc, the reflex for "I opened the wrong tab", would no longer
 * close anything. Recent-first already reduces "sources for the last answer" to
 * a single Enter, which is what the cost of an extra keystroke was buying.
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
  // Recent-first (#248). `useState`'s initializer runs once, at mount, which is
  // exactly the intent: it is a DEFAULT, not a pin — every later cursor move
  // goes through `moveTurn`. Recomputing the seed each render is free, and the
  // viewer is modal over an idle agent, so `turns` cannot grow underneath it.
  const firstTurn = openAtNewest(turns.length, viewport);
  const [turnCursor, setTurnCursor] = useState(firstTurn.cursor);
  const [turnOffset, setTurnOffset] = useState(firstTurn.offset);
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
        keyHints={[HINT_MOVE, { key: KEY.enter, label: 'open' }, HINT_SWITCH_TAB, HINT_CLOSE]}
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
                <Text key={`p-${i}`}>
                  {line.length === 0
                    ? ' ' /* Ink collapses a truly empty Text — keep the row. */
                    : line.map((span, j) => (
                        <Text key={`s-${j}`} color={spanColor(span.role, colors)}>
                          {span.text}
                        </Text>
                      ))}
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
/** Joins the fields that share the card's `kind · cited · when` row. Measured
 *  and rendered from the same constant so the budget cannot drift from the
 *  row it is budgeting for. */
const SEP = ' · ';

function buildCitationDetail(
  source: SourceItem,
  cited: boolean,
  innerWidth: number,
  colors: ThemeColors,
): { header: ReactNode[]; lines: RichLine[] } {
  const w = Math.max(8, innerWidth);

  // Wrap the title onto new lines rather than cutting it off with an ellipsis.
  // Each wrapped line is exactly one terminal row, so the height math (which
  // counts header nodes) stays honest.
  const titleLines = wrapText(source.label, w);
  if (titleLines.length > MAX_TITLE_LINES) {
    titleLines.length = MAX_TITLE_LINES;
    titleLines[MAX_TITLE_LINES - 1] = truncate(titleLines[MAX_TITLE_LINES - 1] + '…', w);
  }

  // Budget for the timestamp is what the row has left after the two labels and
  // the ` · ` that joins them — computed, not truncated, because `truncate`
  // would cut mid-`ago)` and read as corrupt rather than as absent.
  //
  // The labels are built once and both measured and rendered from the same
  // values: a budget that restates the row's wording is a budget that goes
  // quietly wrong the first time someone edits one and not the other.
  const citedLabel = cited ? 'cited' : 'not cited';
  const meta = [source.kind, citedLabel].join(SEP);
  const when = sourceWhen(source.timestamp, w - meta.length - SEP.length);

  const header: ReactNode[] = [
    ...titleLines.map((line, i) => (
      <Text key={`title-${i}`} color={colors.accent} bold>
        {line}
      </Text>
    )),
    // Kind, citation status and WHEN share one row (#248). The card's height is
    // already spent on a border, a wrapped title and a `rawRef`, and every row
    // taken here is a row of the excerpt that isn't shown — so the timestamp
    // rides the shortest existing line instead of claiming its own. Themed
    // muted, not Ink's raw `dimColor`, which ignores the active theme (#320).
    <Text key="kind" wrap="truncate-end">
      <Text color={colors.muted}>{source.kind}</Text>
      <Text color={cited ? colors.success : colors.muted}>{`${SEP}${citedLabel}`}</Text>
      {when && <Text color={colors.muted}>{`${SEP}${when}`}</Text>}
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

  const lines: RichLine[] = source.contentPreview
    ? buildPreviewLines(source.contentPreview, w)
    : [[{ text: '(no content preview)', role: 'muted' }]];
  return { header, lines };
}

/**
 * `2:41 PM (3m5s ago)` — when a source was registered, plus how long ago, when
 * both fit `budget`; the clock alone when only that fits; `''` when neither does
 * or the record carries no usable stamp.
 *
 * `SourceItem.timestamp` has always been recorded and never rendered, which is
 * what made "is this citation from this turn or an hour ago?" unanswerable from
 * the viewer. Absolute AND relative because each answers a different question —
 * the clock places it against the transcript, the age places it against now —
 * and the pair is short enough to share a row.
 *
 * A non-positive or non-finite stamp yields nothing rather than 1970: a record
 * predating the field (or a hand-edited one) must not render a confident lie.
 */
function sourceWhen(timestamp: number, budget: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const clock = formatFriendlyTimestamp(new Date(timestamp));
  const age = Date.now() - timestamp;
  // A future stamp means clock skew, not a negative age — show the time only.
  const full = age >= 0 ? `${clock} (${formatElapsed(age)} ago)` : clock;
  if (full.length <= budget) return full;
  return clock.length <= budget ? clock : '';
}

/** Resolve a {@link SpanRole} against the active theme — never Ink's raw
 *  `dimColor`, which ignores the theme the colorblind/high-contrast palettes
 *  exist to override (#320). */
function spanColor(role: SpanRole, colors: ThemeColors): string {
  return role === 'accent' ? colors.accent : role === 'muted' ? colors.muted : colors.text;
}
