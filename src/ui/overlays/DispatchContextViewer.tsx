import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useDimensionsCtx } from '../DimensionsContext.js';
import { getDispatchContexts, type DispatchContextRecord } from '../../dispatch-context-history.js';
import { getThemeColors } from '../../theme.js';
import { truncate, scopeList } from '../../text.js';
import { formatTokenCount } from '../../output.js';
import { SCOPE_AXES } from '../../framework/agents/dispatch-profile.js';
// The chars→tokens divisor, not a third spelled-out `/ 4`: that helper exists
// so the caller's estimate and `emergencyTruncate`'s answer cannot disagree,
// and the input here IS the rendered context prefix it measures.
import { estimatePrefixTokens } from '../../token-estimate.js';
import { ViewerShell, viewerViewport } from './ViewerShell.js';
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
import { KEY, HINT_MOVE, HINT_SCROLL, HINT_SWITCH_TAB, HINT_CLOSE, HINT_BACK } from '../hints.js';

interface Props {
  onClose?: () => void;
  onCycleTab?: () => void;
}

/** Width of the `MenuRow` selection gutter (`> ` / `  `). */
const GUTTER = MENU_MARKER.length;

/**
 * What each dispatch was given (#512) — the sibling `ContextViewer` could never
 * show.
 *
 * That one reads `agent.getTurnContext()`, and `turnContext.push` happens at
 * exactly one site inside `Agent.processInput`, so a sub-agent, task,
 * specialist, delegate or cron dispatch's context assembly appeared nowhere.
 * This reads the module-level recorder `runDefinition` writes to, so every
 * dispatch in the session is listed regardless of who ran it.
 *
 * A separate tab rather than a section inside `ContextViewer`, and deliberately:
 * that component's test fake is a single-method `{ getTurnContext }`, so a
 * second data source there would break it — and the two answer different
 * questions anyway (a turn's pre-turn pipeline vs. one assembly's output).
 */
export function DispatchContextViewer({ onClose, onCycleTab }: Props) {
  const colors = getThemeColors();
  const { columns: cols, rows } = useDimensionsCtx();
  const viewport = viewerViewport(rows, { tabCount: VIEWER_TABS.length });
  const records = useMemo(() => getDispatchContexts(), []);

  const seed = openAtNewest(records.length, viewport);
  const [cursor, setCursor] = useState(seed.cursor);
  const [offset, setOffset] = useState(seed.offset);
  const [drilled, setDrilled] = useState(false);
  const [bodyOffset, setBodyOffset] = useState(0);

  const usableCols = Math.max(20, cols - 4); // App wraps the overlay in paddingX={2}.
  const selected = drilled ? records[cursor] : undefined;
  const atList = selected === undefined;

  const lines = useMemo(
    () => (selected ? wrapText(detailBody(selected), usableCols) : []),
    [selected, usableCols],
  );
  const maxBodyOffset = Math.max(0, lines.length - viewport);

  useInput(
    (input, key) => {
      if (records.length === 0) return;
      const delta = navDelta(input, key, viewport, records.length);
      if (delta !== null) {
        const next = clamp(cursor + delta, 0, records.length - 1);
        setCursor(next);
        setOffset((o) => clampOffset(next, o, viewport, records.length));
        return;
      }
      if (key.return || key.rightArrow) {
        setDrilled(true);
        setBodyOffset(0);
      }
    },
    { isActive: atList },
  );

  useInput(
    (input, key) => {
      if (key.escape || key.leftArrow) return void setDrilled(false);
      const delta = navDelta(input, key, viewport, lines.length);
      if (delta !== null) setBodyOffset((o) => clamp(o + delta, 0, maxBodyOffset));
    },
    { isActive: !atList },
  );

  if (atList) {
    return (
      <ViewerShell
        tabs={VIEWER_TABS}
        activeTab="dispatch"
        position={listPosition(offset, viewport, records.length)}
        keyHints={[HINT_MOVE, { key: KEY.enter, label: 'open' }, HINT_SWITCH_TAB, HINT_CLOSE]}
        onClose={onClose}
        onCycleTab={onCycleTab}
      >
        {records.length === 0 ? (
          <Text dimColor>No dispatch context recorded yet.</Text>
        ) : (
          records.slice(offset, offset + viewport).map((r, i) => {
            const idx = offset + i;
            const trailing = ` ${formatTokenCount(estimatePrefixTokens(estimateChars(r)))}`;
            const budget = Math.max(10, usableCols - GUTTER - trailing.length);
            return (
              <MenuRow
                key={`${r.dispatchId}-${idx}`}
                selected={idx === cursor}
                label={truncate(summaryLine(r), budget)}
                trailing={trailing}
              />
            );
          })
        )}
      </ViewerShell>
    );
  }

  return (
    <ViewerShell
      tabs={VIEWER_TABS}
      activeTab="dispatch"
      position={listPosition(bodyOffset, viewport, lines.length)}
      keyHints={[HINT_SCROLL, HINT_BACK, HINT_SWITCH_TAB, HINT_CLOSE]}
      onClose={onClose}
      onCycleTab={onCycleTab}
    >
      <Box flexDirection="column">
        {lines.slice(bodyOffset, bodyOffset + viewport).map((line, i) => (
          <Text key={`line-${bodyOffset + i}`} color={colors.muted}>
            {line}
          </Text>
        ))}
      </Box>
    </ViewerShell>
  );
}

/** Total rendered context size — the number worth sorting a hunt by. */
function estimateChars(r: DispatchContextRecord): number {
  return Object.values(r.sections).reduce((n, v) => n + v, 0);
}

function summaryLine(r: DispatchContextRecord): string {
  const site = r.telemetrySite === r.definitionId ? '' : ` → ${r.telemetrySite}`;
  const dropped = r.memoryDropped?.length ?? 0;
  // The drop is named in the row, not only in the detail: it is the one fact
  // here that means something went missing, and a viewer that hides it behind
  // a keystroke is the same silence #528 removed from the render path.
  const warn = dropped > 0 ? ` · ⚠ ${dropped} memory dropped` : '';
  return `${r.definitionId}${site}${warn} · ${r.dispatchId}`;
}

/**
 * Exported for `knowledge/__tests__/fence.test.ts`, which used to assert on
 * this file's SOURCE TEXT — regex-matching the header guard and a literal
 * interpolation. That was the regression test for the #550 bug, and a
 * table-driven rewrite breaks it by construction, so it is replaced by a
 * behavioural assertion against the renderer itself.
 */
export function detailBody(r: DispatchContextRecord): string {
  const parts: string[] = [
    `${r.definitionId} · ${r.telemetrySite} · dispatch ${r.dispatchId}`,
    '',
    'Sections (rendered chars):',
    ...Object.entries(r.sections)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, size]) => `  ${tag}: ${size}`),
  ];
  // Above the memory listing on purpose: the fence is what explains the
  // listing, and a reader who meets the short list first has already formed
  // the wrong conclusion (#511).
  // Every axis, not two of three. A corpus-only fence rendered NO "Scoped to:"
  // header at all — not a missing line inside an otherwise-correct block, but
  // the whole section silently absent on exactly the dispatch the record exists
  // to explain. A fence and a bad retrieval look identical from outside, and
  // this is the surface that tells them apart.
  // Driven by the table, so the header guard and the lines cannot disagree
  // about which axes exist — the #550 bug was exactly that disagreement, one
  // axis short in the guard (#552).
  if (SCOPE_AXES.some((axis) => r[axis.field])) {
    parts.push('', 'Scoped to:');
    for (const axis of SCOPE_AXES) {
      const value = r[axis.field];
      if (value) parts.push(`  ${axis.label}: ${scopeList(value)}`);
    }
  }
  if (r.retrievalQuery) {
    parts.push('', 'Retrieved for:', `  ${r.retrievalQuery}`);
  }
  if (r.memoryKept || r.memoryDropped) {
    parts.push('', `Curated memory injected (${r.memoryKept?.length ?? 0}):`);
    for (const key of r.memoryKept ?? []) parts.push(`  ${key}`);
    if (r.memoryDropped && r.memoryDropped.length > 0) {
      // Named, not counted. "2 entries were dropped" cannot be acted on.
      parts.push('', `Dropped by the byte cap (${r.memoryDropped.length}):`);
      for (const key of r.memoryDropped) parts.push(`  ${key}`);
    }
  }
  return parts.join('\n');
}
