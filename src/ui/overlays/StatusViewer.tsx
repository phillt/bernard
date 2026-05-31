import { Box, Text } from 'ink';
import type { Agent } from '../../agent.js';
import type { BernardConfig } from '../../config.js';
import {
  pickActiveStep,
  summarizePlan,
  type AgentStatusInputs,
} from '../../agent-status.js';
import { getThemeColors } from '../../theme.js';

interface StatusViewerProps {
  agent: Agent;
  config: BernardConfig;
  sessionAllowedCount: number;
}

const LABEL_WIDTH = 15;
const MAX_VALUE_CHARS = 200;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Full-screen Agent Status panel. Replaces the legacy `buildAgentStatusPanel`
 * + `setPinnedRegion('viewer', …)` flow from `src/repl.ts`. Renders the same
 * `AgentStatusInputs` shape that `src/agent-status.ts:15` defines, but as Ink
 * components — no ANSI assembly, no pinned region.
 *
 * **Closes #211 round-2 bug 1 by construction**: there is no pinned-region
 * concept in Ink. The panel is just a JSX subtree that fills the viewport
 * above the thread; closing it (Esc) unmounts the subtree and Ink's render
 * diff leaves the thread + prompt in place.
 */
export function StatusViewer({ agent, config, sessionAllowedCount }: StatusViewerProps) {
  const colors = getThemeColors();
  const inputs = collectStatusInputs(agent, config, sessionAllowedCount);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent} bold>
        Agent Status
      </Text>
      <Text> </Text>
      <Row label="Goal" value={inputs.goal ? truncate(inputs.goal, MAX_VALUE_CHARS) : '(none)'} />
      <Row label="Permissions" value={permissionsValue(inputs.permissions)} />
      <Row label="Strategy" value={inputs.constraints?.strategyId ?? '(none)'} />
      <Row label="Response shape" value={responseShapeValue(inputs.constraints)} />
      <AssumptionsRows assumptions={inputs.assumptions} />
      <PlanStepRow planStep={inputs.planStep} planSummary={inputs.planSummary} />
      <VerificationRow entry={inputs.lastVerification} />
      <Text> </Text>
      <Text dimColor>Esc to close · Shift-Tab to switch tabs</Text>
    </Box>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text dimColor>{label.padEnd(LABEL_WIDTH)}</Text>
      <Text>{value}</Text>
    </Box>
  );
}

function AssumptionsRows({
  assumptions,
}: {
  assumptions: AgentStatusInputs['assumptions'];
}) {
  if (assumptions.length === 0) return <Row label="Assumptions" value="(none)" />;
  return (
    <Box flexDirection="column">
      {assumptions.map((a, idx) => {
        const text = `"${a.phrase}" → ${truncate(a.resolvedTo, 80)} (${a.sourceKey})`;
        return (
          <Box key={idx}>
            <Text dimColor>{(idx === 0 ? 'Assumptions' : '').padEnd(LABEL_WIDTH)}</Text>
            <Text>{text}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function PlanStepRow({
  planStep,
  planSummary,
}: {
  planStep: AgentStatusInputs['planStep'];
  planSummary: AgentStatusInputs['planSummary'];
}) {
  if (!planStep) return <Row label="Plan step" value="(none)" />;
  const { id, status, description, verification } = planStep;
  const header = `[${status}] ${id} of ${planSummary.total} — ${truncate(description, 120)}`;
  return (
    <Box flexDirection="column">
      <Row label="Plan step" value={header} />
      {verification && (
        <Box>
          <Text dimColor>{''.padEnd(LABEL_WIDTH)}</Text>
          <Text dimColor>verify: {truncate(verification, 120)}</Text>
        </Box>
      )}
      {planSummary.done > 0 && planSummary.done < planSummary.total && (
        <Box>
          <Text dimColor>{''.padEnd(LABEL_WIDTH)}</Text>
          <Text dimColor>
            ({planSummary.done}/{planSummary.total} done)
          </Text>
        </Box>
      )}
    </Box>
  );
}

function VerificationRow({ entry }: { entry: AgentStatusInputs['lastVerification'] }) {
  const colors = getThemeColors();
  if (!entry) return <Row label="Last verify" value="(none)" />;
  const tagColor =
    entry.verdict === 'pass'
      ? colors.success
      : entry.verdict === 'warn'
        ? colors.warning
        : colors.error;
  return (
    <Box>
      <Text dimColor>{'Last verify'.padEnd(LABEL_WIDTH)}</Text>
      <Text color={tagColor} bold>
        {entry.verdict.toUpperCase()}
      </Text>
      <Text> — {truncate(entry.reason, 120)}</Text>
      {entry.source && <Text dimColor>  ({truncate(entry.source, 60)})</Text>}
    </Box>
  );
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
