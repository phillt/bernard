import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { StatusViewer } from '../overlays/StatusViewer.js';
import type { Agent } from '../../agent.js';
import type { BernardConfig } from '../../config.js';
import type { PolicyDecision } from '../../policy/types.js';
import type { Step } from '../../plan-store.js';
import type { VerificationEntry } from '../../agent-status.js';
import type { ResolvedEntry } from '../../reference-resolver.js';

interface AgentStub {
  goal: string | null;
  policy: PolicyDecision | null;
  refs: ResolvedEntry[];
  steps: Step[];
  verification: VerificationEntry | null;
}

function makeAgent(stub: AgentStub): Agent {
  return {
    getLastUserInput: () => stub.goal,
    getLastPolicyDecision: () => (stub.policy ? { decision: stub.policy, reasons: {} } : null),
    getLastResolvedReferences: () => stub.refs,
    getPlanSnapshot: () => stub.steps,
    getLastVerification: () => stub.verification,
  } as unknown as Agent;
}

const CONFIG: BernardConfig = {
  toolMode: 'read-only',
  confirmMode: 'strict',
} as unknown as BernardConfig;

const FULL_POLICY: PolicyDecision = {
  strategyId: 'react',
  concise: { enabled: true },
  citations: { requireForFactualClaims: true },
  evidence: { requireForVerifiedClaims: true },
} as unknown as PolicyDecision;

describe('<StatusViewer>', () => {
  it('renders every label in the panel', () => {
    const agent = makeAgent({
      goal: 'analyze the codebase',
      policy: FULL_POLICY,
      refs: [],
      steps: [],
      verification: null,
    });
    const { lastFrame } = render(
      createElement(StatusViewer, {
        agent,
        config: CONFIG,
        sessionAllowedCount: 0,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Agent Status');
    expect(frame).toContain('Goal');
    expect(frame).toContain('Permissions');
    expect(frame).toContain('Strategy');
    expect(frame).toContain('Response shape');
    expect(frame).toContain('Assumptions');
    expect(frame).toContain('Plan step');
    expect(frame).toContain('Last verify');
    expect(frame).toContain('analyze the codebase');
    expect(frame).toContain('tools: read-only · confirm: strict');
    expect(frame).toContain('react');
    expect(frame).toContain('concise');
    expect(frame).toContain('citations: required');
    expect(frame).toContain('evidence: required');
    expect(frame).toContain('Esc to close · Shift-Tab to switch tabs');
  });

  it('renders "(none)" for absent values', () => {
    const agent = makeAgent({
      goal: null,
      policy: null,
      refs: [],
      steps: [],
      verification: null,
    });
    const { lastFrame } = render(
      createElement(StatusViewer, {
        agent,
        config: CONFIG,
        sessionAllowedCount: 0,
      }),
    );
    const frame = lastFrame() ?? '';
    // Goal, Strategy, Assumptions, Plan step, Last verify all render (none).
    expect(frame.match(/\(none\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('includes session-allowed count when > 0', () => {
    const agent = makeAgent({
      goal: 'g',
      policy: null,
      refs: [],
      steps: [],
      verification: null,
    });
    const { lastFrame } = render(
      createElement(StatusViewer, {
        agent,
        config: CONFIG,
        sessionAllowedCount: 3,
      }),
    );
    expect(lastFrame()).toContain('(3 session-allowed)');
  });

  it('truncates an oversized goal at 200 chars', () => {
    const longGoal = 'x'.repeat(500);
    const agent = makeAgent({
      goal: longGoal,
      policy: null,
      refs: [],
      steps: [],
      verification: null,
    });
    const { lastFrame } = render(
      createElement(StatusViewer, {
        agent,
        config: CONFIG,
        sessionAllowedCount: 0,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('…');
    expect(frame).not.toContain(longGoal);
  });

  it('renders assumptions as multiple rows', () => {
    const agent = makeAgent({
      goal: 'g',
      policy: null,
      refs: [
        { phrase: 'my daughter', resolvedTo: 'Alice', sourceKey: 'memory:family' },
        { phrase: 'the project', resolvedTo: 'Bernard', sourceKey: 'memory:projects' },
      ] as unknown as ResolvedEntry[],
      steps: [],
      verification: null,
    });
    const { lastFrame } = render(
      createElement(StatusViewer, {
        agent,
        config: CONFIG,
        sessionAllowedCount: 0,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('"my daughter" → Alice');
    expect(frame).toContain('"the project" → Bernard');
    expect(frame).toContain('(memory:family)');
  });

  it('renders the active plan step and progress', () => {
    const agent = makeAgent({
      goal: 'g',
      policy: null,
      refs: [],
      steps: [
        { id: 1, status: 'done', description: 'step one' },
        { id: 2, status: 'in_progress', description: 'step two', verification: 'lint passes' },
        { id: 3, status: 'pending', description: 'step three' },
      ] as unknown as Step[],
      verification: null,
    });
    const { lastFrame } = render(
      createElement(StatusViewer, {
        agent,
        config: CONFIG,
        sessionAllowedCount: 0,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[in_progress] 2 of 3 — step two');
    expect(frame).toContain('verify: lint passes');
    expect(frame).toContain('(1/3 done)');
  });

  it('renders verification verdicts in their respective tags', () => {
    for (const verdict of ['pass', 'warn', 'fail'] as const) {
      const agent = makeAgent({
        goal: 'g',
        policy: null,
        refs: [],
        steps: [],
        verification: {
          verdict,
          reason: 'because',
          source: 'sub:1',
        },
      });
      const { lastFrame } = render(
        createElement(StatusViewer, {
          agent,
          config: CONFIG,
          sessionAllowedCount: 0,
        }),
      );
      expect(lastFrame()).toContain(verdict.toUpperCase());
      expect(lastFrame()).toContain('because');
    }
  });
});
