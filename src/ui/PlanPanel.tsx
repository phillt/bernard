import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { Agent } from '../agent.js';
import type { Step, StepStatus } from '../plan-store.js';
import { getThemeColors, type ThemeColors } from '../theme.js';
import { summarizePlan } from '../agent-status.js';

interface PlanPanelProps {
  agent: Agent;
}

/** Max characters of a cancelled/error step's note shown inline. */
const NOTE_MAX_CHARS = 60;

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
 * Renders the full step list (icons + descriptions, notes on failed steps) and
 * subscribes to the PlanStore so mid-turn mutations re-render immediately.
 *
 * Layout (#plan-restyle): the panel is the *top section of the input dock*. It
 * renders a header, the wrapping step list, and a full-width interior divider,
 * with no border or margin of its own — `<Prompt>` draws the single rounded box
 * around this panel + the input line, so the plan reads as an extension of the
 * input box rather than a separate ruled-off region. Returns `null` (collapsing
 * the dock back to a plain input box) when no plan exists.
 *
 * Steps wrap instead of truncating, with a hanging indent: a fixed-width
 * `{icon} {id}.` gutter and a flex description column, so continuation lines
 * align under the description start.
 *
 * No step-count cap by design (full panel). A very long plan in a short
 * terminal can push the transcript up; if that ever bites, cap with a
 * `steps.slice(...)` windowed on the active step.
 */
export function PlanPanel({ agent }: PlanPanelProps) {
  const colors = getThemeColors();
  const [steps, setSteps] = useState<Step[]>(() => agent.getPlanSnapshot());

  useEffect(() => {
    // Re-sync on mount in case mutations happened before the effect ran.
    setSteps(agent.getPlanSnapshot());
    return agent.subscribeToPlanStore(() => {
      setSteps(agent.getPlanSnapshot());
    });
  }, [agent]);

  if (steps.length === 0) return null;
  const { done, total } = summarizePlan(steps);
  // Fixed-width gutter cells so the description column aligns across rows and
  // stays deterministic regardless of how the terminal measures the status
  // glyph: a 2-col icon cell (✔/✘ measure as 1 or 2 in different locales — the
  // fixed cell absorbs the difference) and an id cell sized to the widest id.
  const maxIdLen = Math.max(...steps.map((s) => String(s.id).length));
  const idCellWidth = maxIdLen + 2; // "<id>. "

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
        {steps.map((step) => {
          const { icon, color } = stepIcon(step.status, colors);
          const active = step.status === 'in_progress';
          const pending = step.status === 'pending';
          const failedNote =
            (step.status === 'cancelled' || step.status === 'error') && step.note
              ? step.note.slice(0, NOTE_MAX_CHARS)
              : null;
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
                <Text wrap="wrap" bold={active} dimColor={pending}>
                  {step.description}
                  {failedNote && <Text dimColor> · {failedNote}</Text>}
                </Text>
              </Box>
            </Box>
          );
        })}
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
