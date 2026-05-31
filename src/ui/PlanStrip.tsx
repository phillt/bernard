import { Box, Text } from 'ink';
import type { Agent } from '../agent.js';
import { getThemeColors } from '../theme.js';
import { pickActiveStep, summarizePlan } from '../agent-status.js';

interface PlanStripProps {
  agent: Agent;
}

/**
 * Replaces the legacy pinned plan region. Reads `agent.getPlanSnapshot()` and
 * renders a one-line summary of the active step plus a `done/total` count.
 * Mounted above `<Prompt>` in the `<App>` JSX so it sits in the same screen
 * position as the legacy region.
 */
export function PlanStrip({ agent }: PlanStripProps) {
  const colors = getThemeColors();
  const steps = agent.getPlanSnapshot();
  const active = pickActiveStep(steps);
  const { done, total } = summarizePlan(steps);
  if (total === 0) return null;
  return (
    <Box flexDirection="row" marginLeft={2}>
      <Text color={colors.accent} bold>
        plan
      </Text>
      <Text dimColor>
        {' '}
        {done}/{total}
      </Text>
      {active && (
        <Text>
          {'  '}
          {active.description}
        </Text>
      )}
    </Box>
  );
}
