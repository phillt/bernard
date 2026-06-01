import type { PolicyDecision } from './policy/types.js';
import type { ResolvedEntry } from './reference-resolver.js';
import type { Step } from './plan-store.js';
import type { Check, Verdict } from './rubric.js';

/**
 * Snapshot of "what Bernard believes its operating state is" for one turn.
 *
 * Every field is derived from data that already flows through the agent loop
 * — there is no `set_status` tool and no agent-prompt change. The Agent class
 * caches each piece as it passes through `processInput`; the REPL aggregates
 * them on demand when the user opens the Shift+Tab viewer. Issue #140.
 */
export interface AgentStatusInputs {
  /** The user's most recent turn (raw, pre-rewrite). `null` before any turn. */
  goal: string | null;
  permissions: {
    /** Mirrors `BernardConfig.toolMode`. */
    toolMode: 'read-only' | 'write';
    /** Mirrors `BernardConfig.confirmMode`. */
    confirmMode: 'off' | 'auto' | 'strict';
    /** Number of tools the user opted into via "Enable for this tool, this session". */
    sessionAllowedCount: number;
  };
  /** Last `PolicyResult.decision`. Drives Strategy + Response shape rows. */
  constraints: PolicyDecision | null;
  /** Reference-resolver entries this turn (resolved phrases). */
  assumptions: ResolvedEntry[];
  /** Active plan step: `in_progress` if any, else the first `pending`, else null. */
  planStep: Step | null;
  planSummary: { done: number; total: number };
  /** Result of the most recent PAC critic. `null` if no sub-agent has run. */
  lastVerification: VerificationEntry | null;
}

export interface VerificationEntry {
  verdict: Verdict;
  reason: string;
  /** Free-form label of what was verified (e.g. sub-agent task summary). */
  source: string;
  /**
   * Structured checks behind the verdict (issue #145). Present when the verdict
   * was produced by a rubric-aware site (PAC critic, the `evaluate` tool with
   * structured checks). Absent for legacy callers.
   */
  checks?: Check[];
}

/**
 * Small per-session store for the most recent PAC critic verdict.
 *
 * Lives on `AgentContext.verification` so sub-agent dispatch sites can write
 * back without holding an Agent reference. Last-write-wins (this is a
 * snapshot, not a log). The Agent clears it at the top of each `processInput`
 * so a stale verdict from a prior turn doesn't show up in the status panel.
 */
export class VerificationStore {
  private last: VerificationEntry | null = null;

  setLast(entry: VerificationEntry): void {
    this.last = entry;
  }

  getLast(): VerificationEntry | null {
    return this.last;
  }

  clear(): void {
    this.last = null;
  }
}

/**
 * Picks the most informative plan step to display: the first `in_progress`,
 * else the first `pending`, else null (everything is terminal).
 */
export function pickActiveStep(steps: Step[]): Step | null {
  return (
    steps.find((s) => s.status === 'in_progress') ??
    steps.find((s) => s.status === 'pending') ??
    null
  );
}

export function summarizePlan(steps: Step[]): { done: number; total: number } {
  return {
    done: steps.filter((s) => s.status === 'done').length,
    total: steps.length,
  };
}

const LABEL_WIDTH = 15;
const MAX_VALUE_CHARS = 200;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function row(label: string, value: string): string {
  const padded = label.padEnd(LABEL_WIDTH);
  return `${padded}${value}`;
}

function continuation(value: string): string {
  return `${' '.repeat(LABEL_WIDTH)}${value}`;
}

function strategyValue(d: PolicyDecision | null): string {
  if (!d) return '(none)';
  return d.strategyId ?? 'normal';
}

function responseShapeValue(d: PolicyDecision | null): string {
  if (!d) return '(none)';
  const parts: string[] = [];
  if (d.concise?.enabled) parts.push('concise');
  if (d.citations?.requireForFactualClaims) parts.push('citations: required');
  if (d.evidence?.requireForVerifiedClaims) parts.push('evidence: required');
  return parts.length > 0 ? parts.join(' · ') : 'default';
}

function permissionsValue(p: AgentStatusInputs['permissions']): string {
  const base = `tools: ${p.toolMode} · confirm: ${p.confirmMode}`;
  if (p.sessionAllowedCount > 0) {
    return `${base} (${p.sessionAllowedCount} session-allowed)`;
  }
  return base;
}

/**
 * Renders the Agent Status panel as plain-text lines. Callers that want
 * color (the Ink {@link import('./ui/overlays/StatusViewer.js').StatusViewer})
 * own their own coloring; this builder produces the textual content.
 *
 * Empty sections render as `(none)` rather than hiding — predictability
 * over compactness for an inspection tool.
 */
export function buildAgentStatusPanel(inputs: AgentStatusInputs): string[] {
  const lines: string[] = [];

  lines.push(row('Goal', inputs.goal ? truncate(inputs.goal, MAX_VALUE_CHARS) : '(none)'));
  lines.push(row('Permissions', permissionsValue(inputs.permissions)));
  lines.push(row('Strategy', strategyValue(inputs.constraints)));
  lines.push(row('Response shape', responseShapeValue(inputs.constraints)));

  if (inputs.assumptions.length === 0) {
    lines.push(row('Assumptions', '(none)'));
  } else {
    inputs.assumptions.forEach((a, i) => {
      const text = `"${a.phrase}" → ${truncate(a.resolvedTo, 80)} (${a.sourceKey})`;
      lines.push(i === 0 ? row('Assumptions', text) : continuation(text));
    });
  }

  if (inputs.planStep) {
    const { id, status, description, verification } = inputs.planStep;
    const { done, total } = inputs.planSummary;
    const header = `[${status}] ${id} of ${total} — ${truncate(description, 120)}`;
    lines.push(row('Plan step', header));
    if (verification) {
      lines.push(continuation(`verify: ${truncate(verification, 120)}`));
    }
    if (done > 0 && done < total) {
      lines.push(continuation(`(${done}/${total} done)`));
    }
  } else {
    lines.push(row('Plan step', '(none)'));
  }

  if (inputs.lastVerification) {
    const v = inputs.lastVerification;
    const tag =
      v.verdict === 'pass' ? 'PASS' : v.verdict === 'warn' ? 'WARN' : 'FAIL';
    const body = ` — ${truncate(v.reason, 120)}`;
    const tail = v.source ? `  (${truncate(v.source, 60)})` : '';
    lines.push(row('Last verify', `${tag}${body}${tail}`));
  } else {
    lines.push(row('Last verify', '(none)'));
  }

  return lines;
}

/**
 * Plain-text variant used by cron logs and non-TTY contexts.
 */
export function renderAgentStatusPlain(inputs: AgentStatusInputs): string {
  return buildAgentStatusPanel(inputs).join('\n');
}
