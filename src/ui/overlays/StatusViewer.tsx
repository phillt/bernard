import { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { Agent } from '../../agent.js';
import type { BernardConfig } from '../../config.js';
import { pickActiveStep, summarizePlan, type AgentStatusInputs } from '../../agent-status.js';
import { getThemeColors } from '../../theme.js';
import { truncate } from '../../text.js';
import { ScrollableOverlay, type OverlayLine } from './ScrollableOverlay.js';

interface StatusViewerProps {
  agent: Agent;
  config: BernardConfig;
  sessionAllowedCount: number;
  /** Close the panel (Esc). Defaults to a no-op for standalone rendering/tests. */
  onClose?: () => void;
  /** Advance to the next Shift-Tab tab. Defaults to a no-op. */
  onCycleTab?: () => void;
}

const LABEL_WIDTH = 15;
const MAX_VALUE_CHARS = 200;

/**
 * Scrollable Agent Status panel. Flattens the `AgentStatusInputs` shape into
 * one visual row per line and renders through the shared `ScrollableOverlay`,
 * so it shares the full-screen "replaces the thread" treatment and the
 * Esc / Shift-Tab keystream with `SourcesViewer` (issue #211).
 */
export function StatusViewer({
  agent,
  config,
  sessionAllowedCount,
  onClose,
  onCycleTab,
}: StatusViewerProps) {
  // Status fields are stable while the viewer owns the keystream (the agent is
  // idle), so collect + flatten once rather than on every scroll keystroke.
  const lines = useMemo(
    () => buildLines(collectStatusInputs(agent, config, sessionAllowedCount)),
    [agent, config, sessionAllowedCount],
  );
  return (
    <ScrollableOverlay
      title="Agent Status"
      lines={lines}
      onClose={onClose}
      onCycleTab={onCycleTab}
    />
  );
}

function buildLines(inputs: AgentStatusInputs): OverlayLine[] {
  const lines: OverlayLine[] = [];
  const row = (key: string, label: string, value: string) =>
    lines.push({ key, node: <RowNode label={label} value={value} /> });

  row('goal', 'Goal', inputs.goal ? truncate(inputs.goal, MAX_VALUE_CHARS) : '(none)');
  row('permissions', 'Permissions', permissionsValue(inputs.permissions));
  row('strategy', 'Strategy', inputs.constraints?.strategyId ?? '(none)');
  row('response', 'Response shape', responseShapeValue(inputs.constraints));
  pushAssumptions(lines, inputs.assumptions);
  pushPlanStep(lines, inputs.planStep, inputs.planSummary);
  pushVerification(lines, inputs.lastVerification);
  return lines;
}

function RowNode({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text dimColor>{label.padEnd(LABEL_WIDTH)}</Text>
      <Text>{value}</Text>
    </Box>
  );
}

function pushAssumptions(lines: OverlayLine[], assumptions: AgentStatusInputs['assumptions']): void {
  if (assumptions.length === 0) {
    lines.push({ key: 'assumptions', node: <RowNode label="Assumptions" value="(none)" /> });
    return;
  }
  assumptions.forEach((a, idx) => {
    const text = `"${a.phrase}" → ${truncate(a.resolvedTo, 80)} (${a.sourceKey})`;
    lines.push({
      key: `assumption-${idx}`,
      node: (
        <Box>
          <Text dimColor>{(idx === 0 ? 'Assumptions' : '').padEnd(LABEL_WIDTH)}</Text>
          <Text>{text}</Text>
        </Box>
      ),
    });
  });
}

function pushPlanStep(
  lines: OverlayLine[],
  planStep: AgentStatusInputs['planStep'],
  planSummary: AgentStatusInputs['planSummary'],
): void {
  if (!planStep) {
    lines.push({ key: 'plan-step-none', node: <RowNode label="Plan step" value="(none)" /> });
    return;
  }
  const { id, status, description, verification } = planStep;
  const header = `[${status}] ${id} of ${planSummary.total} — ${truncate(description, 120)}`;
  lines.push({ key: 'plan-step', node: <RowNode label="Plan step" value={header} /> });
  if (verification) {
    lines.push({
      key: 'plan-step-verify',
      node: (
        <Box>
          <Text dimColor>{''.padEnd(LABEL_WIDTH)}</Text>
          <Text dimColor>verify: {truncate(verification, 120)}</Text>
        </Box>
      ),
    });
  }
  if (planSummary.done > 0 && planSummary.done < planSummary.total) {
    lines.push({
      key: 'plan-step-progress',
      node: (
        <Box>
          <Text dimColor>{''.padEnd(LABEL_WIDTH)}</Text>
          <Text dimColor>
            ({planSummary.done}/{planSummary.total} done)
          </Text>
        </Box>
      ),
    });
  }
}

function pushVerification(
  lines: OverlayLine[],
  entry: AgentStatusInputs['lastVerification'],
): void {
  if (!entry) {
    lines.push({ key: 'last-verify', node: <RowNode label="Last verify" value="(none)" /> });
    return;
  }
  const colors = getThemeColors();
  const tagColor =
    entry.verdict === 'pass'
      ? colors.success
      : entry.verdict === 'warn'
        ? colors.warning
        : colors.error;
  lines.push({
    key: 'last-verify',
    node: (
      <Box>
        <Text dimColor>{'Last verify'.padEnd(LABEL_WIDTH)}</Text>
        <Text color={tagColor} bold>
          {entry.verdict.toUpperCase()}
        </Text>
        <Text> — {truncate(entry.reason, 120)}</Text>
        {entry.source && <Text dimColor> ({truncate(entry.source, 60)})</Text>}
      </Box>
    ),
  });
}

function permissionsValue(p: AgentStatusInputs['permissions']): string {
  const base = `tools: ${p.toolMode} · confirm: ${p.confirmMode}`;
  if (p.sessionAllowedCount > 0) return `${base} (${p.sessionAllowedCount} session-allowed)`;
  return base;
}

function responseShapeValue(d: AgentStatusInputs['constraints']): string {
  if (!d) return '(none)';
  const parts: string[] = [];
  if (d.concise?.enabled) parts.push('concise');
  if (d.citations?.requireForFactualClaims) parts.push('citations: required');
  if (d.evidence?.requireForVerifiedClaims) parts.push('evidence: required');
  return parts.length > 0 ? parts.join(' · ') : 'default';
}

function collectStatusInputs(
  agent: Agent,
  config: BernardConfig,
  sessionAllowedCount: number,
): AgentStatusInputs {
  const steps = agent.getPlanSnapshot();
  return {
    goal: agent.getLastUserInput(),
    permissions: {
      toolMode: config.toolMode,
      confirmMode: config.confirmMode,
      sessionAllowedCount,
    },
    constraints: agent.getLastPolicyDecision()?.decision ?? null,
    assumptions: agent.getLastResolvedReferences(),
    planStep: pickActiveStep(steps),
    planSummary: summarizePlan(steps),
    lastVerification: agent.getLastVerification(),
  };
}
