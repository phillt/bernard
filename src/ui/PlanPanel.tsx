import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { Agent } from '../agent.js';
import type { Step, StepStatus } from '../plan-store.js';
import { getThemeColors, type ThemeColors } from '../theme.js';
import { summarizePlan } from '../agent-status.js';
import { truncate } from '../text.js';
import { useDimensionsCtx } from './DimensionsContext.js';
import { NOTE_SEPARATOR, planWindow, splitStepWidth, stepTextWidth } from './plan-window.js';
import { formatPosition } from './overlays/viewer-util.js';

interface PlanPanelProps {
  agent: Agent;
  /**
   * Total terminal rows this panel may occupy, chrome included. Computed by
   * `Prompt` (`planPanelMaxRows`) because only the caller knows what box the
   * panel sits in — the same contract as `BoundedLine`'s `reserveColumns`.
   * Required, not defaulted: a default is the shape that lets a new call site
   * silently reintroduce the unbounded panel.
   */
  maxRows: number;
  /** Columns of `Prompt`'s own chrome — its rounded border — to subtract. */
  reserveColumns: number;
}

function stepIcon(status: StepStatus, colors: ThemeColors): { icon: string; color?: string } {
  switch (status) {
    case 'done':
      return { icon: '✔', color: colors.success };
    case 'cancelled':
    case 'error':
      return { icon: '✘', color: colors.error };
    case 'in_progress':
      return { icon: '▸', color: colors.accent };
    case 'pending':
      return { icon: '○' };
  }
}

/**
 * Pinned plan panel — the Ink replacement for the legacy ANSI pinned region.
 * Renders a window onto the step list (icons + descriptions, notes on failed
 * steps) and subscribes to the PlanStore so mid-turn mutations re-render
 * immediately.
 *
 * Layout (#plan-restyle): the panel is the *top section of the input dock*. It
 * renders a header, the step list, a scroll-position row and a full-width
 * interior divider, with no border or margin of its own — `<Prompt>` draws the
 * single rounded box around this panel + the input line, so the plan reads as
 * an extension of the input box rather than a separate ruled-off region.
 * Returns `null` (collapsing the dock back to a plain input box) when no plan
 * exists.
 *
 * **Bounded on both axes (#358).** The doc comment that stood here said "no
 * step-count cap by design (full panel)" and predicted the bite; it was
 * understated on both counts. Steps used to `wrap="wrap"` with a hanging
 * indent, and a description is capped per FIELD (400 chars) not per row, so a
 * single maximal step was 6 rows and a 10-step plan of them 63 — nearly three
 * terminal-heights inside a `height={rows}` frame, which `TranscriptViewport`
 * absorbs by shrinking toward zero. Steps now truncate to exactly one row and
 * the list is windowed on the `in_progress` step. All the arithmetic lives in
 * the React-free `plan-window.ts`; see its head for why neither `windowBuffer`
 * nor `overlayViewport` fits.
 */
export function PlanPanel({ agent, maxRows, reserveColumns }: PlanPanelProps) {
  const colors = getThemeColors();
  // The context, never `useStdout` — the context is the one reactive source
  // (SIGWINCH is subscribed once at the top of the tree), and under the test
  // renderer the two disagree: no provider falls back to 80 columns while
  // ink-testing-library's stdout reports 100.
  const { columns } = useDimensionsCtx();
  const [steps, setSteps] = useState<Step[]>(() => agent.getPlanSnapshot());

  useEffect(() => {
    // Re-sync on mount in case mutations happened before the effect ran.
    setSteps(agent.getPlanSnapshot());
    return agent.subscribeToPlanStore(() => {
      setSteps(agent.getPlanSnapshot());
    });
  }, [agent]);

  // `maxRows === 0` is the caller saying the frame has no room to spare — see
  // `planPanelMaxRows`, which yields the whole panel rather than let the prompt
  // box exceed a short terminal. Not an error state: the user can still type.
  if (steps.length === 0 || maxRows <= 0) return null;
  const { done, total } = summarizePlan(steps);
  // Fixed-width gutter cells so the description column aligns across rows and
  // stays deterministic regardless of how the terminal measures the status
  // glyph: a 2-col icon cell (✔/✘ measure as 1 or 2 in different locales — the
  // fixed cell absorbs the difference) and an id cell sized to the widest id.
  const maxIdLen = Math.max(...steps.map((s) => String(s.id).length));
  const idCellWidth = maxIdLen + 2; // "<id>. "
  const textWidth = stepTextWidth(columns, reserveColumns, idCellWidth);

  const { offset, size, position } = planWindow(steps, maxRows);
  const visible = steps.slice(offset, offset + size);

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text color={colors.accent} bold>
          ◇ plan
        </Text>
        <Text dimColor>
          {' '}
          {done}/{total}
        </Text>
      </Box>
      <Box flexDirection="column" paddingLeft={2} paddingRight={1}>
        {visible.map((step) => {
          const { icon, color } = stepIcon(step.status, colors);
          const active = step.status === 'in_progress';
          const pending = step.status === 'pending';
          const note =
            (step.status === 'cancelled' || step.status === 'error') && step.note
              ? step.note
              : null;
          const budget = splitStepWidth(textWidth, note !== null);
          return (
            <Box key={step.id}>
              <Box width={2} flexShrink={0}>
                <Text color={color} dimColor={!color}>
                  {icon}
                </Text>
              </Box>
              <Box width={idCellWidth} flexShrink={0}>
                <Text dimColor={pending}>{step.id}. </Text>
              </Box>
              <Box flexGrow={1}>
                {/* `wrap="truncate"` as well as the arithmetic, and not instead
                    of it: the budgets above are testable without a renderer and
                    keep the two `<Text>` halves from summing past the row, while
                    Ink's own truncation is the structural backstop for the case
                    the arithmetic cannot see — `truncate` measures UTF-16 code
                    units, so a CJK or emoji-heavy description renders wider than
                    it counts (the limitation `line-geometry.ts` documents for
                    the same reason). One step must be one row or the windowing
                    above is invalid. */}
                <Text wrap="truncate" bold={active} dimColor={pending}>
                  {truncate(step.description, budget.description)}
                  {note && (
                    <Text dimColor>
                      {NOTE_SEPARATOR}
                      {truncate(note, budget.note)}
                    </Text>
                  )}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      {/* Always reserved, blank when the whole plan fits — `OverlayFooter`'s
          rule. Rendering it conditionally would make the panel's height depend
          on the budget that decides what is hidden. */}
      <Box paddingX={1}>
        <Text color={colors.muted}>{formatPosition(position, 'steps') ?? ' '}</Text>
      </Box>
      {/* Interior divider between the plan and the input line below it. */}
      <Box
        borderStyle="single"
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor={colors.accent}
        borderDimColor
      />
    </Box>
  );
}
