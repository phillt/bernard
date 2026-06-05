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

/** Full-width horizontal rule (Ink computes the width; no column counting). */
function PanelRule({ color }: { color: string }) {
  return (
    <Box
      borderStyle="single"
      borderTop={true}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={color}
    />
  );
}

/**
 * Pinned plan panel — the Ink replacement for the legacy ANSI pinned region.
 * Renders the full step list (icons + descriptions, notes on failed steps)
 * above `<Prompt>` whenever a plan exists, and subscribes to the PlanStore so
 * mid-turn mutations re-render immediately (the one-line `PlanStrip` it
 * replaces only re-rendered when `<App>` happened to).
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

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color={colors.accent} bold>
          plan
        </Text>
        <Text dimColor>
          {' '}
          {done}/{total}
        </Text>
      </Box>
      <PanelRule color={colors.muted} />
      {steps.map((step) => {
        const { icon, color } = stepIcon(step.status, colors);
        const failedNote =
          (step.status === 'cancelled' || step.status === 'error') && step.note
            ? step.note.slice(0, NOTE_MAX_CHARS)
            : null;
        return (
          <Box key={step.id}>
            <Text wrap="truncate-end">
              {' '}
              <Text color={color} dimColor={!color}>
                {icon}
              </Text>{' '}
              {step.id}. {step.description}
              {failedNote && <Text dimColor> · {failedNote}</Text>}
            </Text>
          </Box>
        );
      })}
      <PanelRule color={colors.muted} />
    </Box>
  );
}
