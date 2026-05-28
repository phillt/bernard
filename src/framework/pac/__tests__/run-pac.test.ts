import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../../agents/run.js', () => ({
  runDefinition: vi.fn(),
}));

import { runDefinition } from '../../agents/run.js';
import { definitions } from '../../agents/registry.js';
import { pacPlannerDefinition } from '../../agents/pac-planner.js';
import { pacActorDefinition } from '../../agents/pac-actor.js';
import { pacCriticDefinition } from '../../agents/pac-critic.js';
import { runPAC, PAC_MAX_RETRIES } from '../run-pac.js';
import type { PacCriticVerdict } from '../../agents/pac-critic.js';
import type { AgentContext } from '../../context.js';

const runDefinitionMock = runDefinition as unknown as Mock;

function fakeCtx(): AgentContext {
  return {
    config: { subagentPac: true } as any,
    stores: {} as any,
    mcp: { tools: {}, serverNames: [] },
    toolOptions: {} as any,
  };
}

interface CannedResponse {
  defId: string;
  formatted: unknown;
}

function setupQueue(responses: CannedResponse[]): { calls: Array<{ defId: string; input: unknown }> } {
  const calls: Array<{ defId: string; input: unknown }> = [];
  let i = 0;
  runDefinitionMock.mockImplementation(async (_ctx, def, input) => {
    const next = responses[i++];
    if (!next) {
      throw new Error(`runDefinition called more times than expected (${i})`);
    }
    if (next.defId !== def.id) {
      throw new Error(
        `expected runDefinition call #${i} to be for '${next.defId}' but got '${def.id}'`,
      );
    }
    calls.push({ defId: def.id, input });
    return { result: {} as any, formatted: next.formatted, resolved: {} as any };
  });
  return { calls };
}

beforeEach(() => {
  runDefinitionMock.mockReset();
  // Ensure all three definitions are registered for `definitions.get()` lookups.
  if (!definitions.has(pacPlannerDefinition.id)) definitions.register(pacPlannerDefinition);
  if (!definitions.has(pacActorDefinition.id)) definitions.register(pacActorDefinition);
  if (!definitions.has(pacCriticDefinition.id)) definitions.register(pacCriticDefinition);
});

describe('runPAC', () => {
  it('happy path: planner → actor → critic(pass) returns Actor output', async () => {
    const passVerdict: PacCriticVerdict = {
      verdict: 'pass',
      reason: 'all criteria met',
      raw: '{"verdict":"pass","reason":"all criteria met"}',
    };
    const { calls } = setupQueue([
      { defId: 'pac-planner', formatted: 'PLAN_V1' },
      { defId: 'pac-actor', formatted: 'ACTOR_OUT_1' },
      { defId: 'pac-critic', formatted: passVerdict },
    ]);

    const result = await runPAC(fakeCtx(), { task: 'do thing', slotId: 7 });

    expect(calls.map((c) => c.defId)).toEqual(['pac-planner', 'pac-actor', 'pac-critic']);
    expect(result.verdict).toBe('pass');
    expect(result.reason).toBe('all criteria met');
    expect(result.retries).toBe(0);
    expect(result.formatted).toBe('ACTOR_OUT_1');
    // No critic-warning footer on pass.
    expect(result.formatted).not.toContain('Critic Verdict: FAIL');
  });

  it('critic fail then pass: re-plan, re-act, re-critic; returns final Actor output', async () => {
    const failVerdict: PacCriticVerdict = {
      verdict: 'fail',
      reason: 'file X was not written',
      raw: '',
    };
    const passVerdict: PacCriticVerdict = {
      verdict: 'pass',
      reason: 'criteria met on retry',
      raw: '',
    };
    const { calls } = setupQueue([
      { defId: 'pac-planner', formatted: 'PLAN_V1' },
      { defId: 'pac-actor', formatted: 'ACTOR_OUT_1' },
      { defId: 'pac-critic', formatted: failVerdict },
      { defId: 'pac-planner', formatted: 'PLAN_V2' },
      { defId: 'pac-actor', formatted: 'ACTOR_OUT_2' },
      { defId: 'pac-critic', formatted: passVerdict },
    ]);

    const result = await runPAC(fakeCtx(), { task: 'do thing', slotId: 3 });

    expect(calls.map((c) => c.defId)).toEqual([
      'pac-planner',
      'pac-actor',
      'pac-critic',
      'pac-planner',
      'pac-actor',
      'pac-critic',
    ]);
    expect(result.verdict).toBe('pass');
    expect(result.retries).toBe(1);
    expect(result.formatted).toBe('ACTOR_OUT_2');
    // Re-planner must have received the prior plan + critic feedback.
    const rePlannerInput = calls[3].input as {
      priorPlan?: string;
      criticFeedback?: string;
    };
    expect(rePlannerInput.priorPlan).toBe('PLAN_V1');
    expect(rePlannerInput.criticFeedback).toBe('file X was not written');
  });

  it('critic fails twice: returns last Actor output with warning footer and verdict=fail', async () => {
    const failVerdict: PacCriticVerdict = {
      verdict: 'fail',
      reason: 'still broken',
      raw: '',
    };
    setupQueue([
      { defId: 'pac-planner', formatted: 'PLAN_V1' },
      { defId: 'pac-actor', formatted: 'ACTOR_OUT_1' },
      { defId: 'pac-critic', formatted: failVerdict },
      { defId: 'pac-planner', formatted: 'PLAN_V2' },
      { defId: 'pac-actor', formatted: 'ACTOR_OUT_2' },
      { defId: 'pac-critic', formatted: failVerdict },
    ]);

    const result = await runPAC(fakeCtx(), { task: 'do thing', slotId: 1 });

    expect(result.verdict).toBe('fail');
    expect(result.retries).toBe(PAC_MAX_RETRIES);
    expect(result.formatted).toContain('ACTOR_OUT_2');
    expect(result.formatted).toContain('Critic Verdict: FAIL');
    expect(result.formatted).toContain('still broken');
  });

  it('does not exceed PAC_MAX_RETRIES + 1 actor runs', async () => {
    const failVerdict: PacCriticVerdict = {
      verdict: 'fail',
      reason: 'no',
      raw: '',
    };
    const { calls } = setupQueue([
      { defId: 'pac-planner', formatted: 'PLAN_V1' },
      { defId: 'pac-actor', formatted: 'A1' },
      { defId: 'pac-critic', formatted: failVerdict },
      { defId: 'pac-planner', formatted: 'PLAN_V2' },
      { defId: 'pac-actor', formatted: 'A2' },
      { defId: 'pac-critic', formatted: failVerdict },
    ]);

    await runPAC(fakeCtx(), { task: 'x', slotId: 1 });

    const actorCalls = calls.filter((c) => c.defId === 'pac-actor');
    expect(actorCalls.length).toBe(PAC_MAX_RETRIES + 1);
  });

  it('forwards abort signal and overrides to every runDefinition call', async () => {
    const passVerdict: PacCriticVerdict = { verdict: 'pass', reason: '', raw: '' };
    setupQueue([
      { defId: 'pac-planner', formatted: 'P' },
      { defId: 'pac-actor', formatted: 'A' },
      { defId: 'pac-critic', formatted: passVerdict },
    ]);

    const ac = new AbortController();
    await runPAC(
      fakeCtx(),
      { task: 'x', slotId: 1 },
      { abortSignal: ac.signal, overrides: { provider: 'xai', model: 'grok-x' } },
    );

    for (const call of runDefinitionMock.mock.calls) {
      const opts = call[3];
      expect(opts.abortSignal).toBe(ac.signal);
      expect(opts.overrides).toEqual({ provider: 'xai', model: 'grok-x' });
    }
  });

  it('actor receives the plan from the planner in its input', async () => {
    const passVerdict: PacCriticVerdict = { verdict: 'pass', reason: '', raw: '' };
    const { calls } = setupQueue([
      { defId: 'pac-planner', formatted: 'THE_PLAN_TEXT' },
      { defId: 'pac-actor', formatted: 'A' },
      { defId: 'pac-critic', formatted: passVerdict },
    ]);

    await runPAC(fakeCtx(), { task: 'x', context: 'ctx', slotId: 9 });

    const actorInput = calls.find((c) => c.defId === 'pac-actor')!.input as {
      plan: string;
      task: string;
      context?: string;
      slotId: number;
    };
    expect(actorInput.plan).toBe('THE_PLAN_TEXT');
    expect(actorInput.task).toBe('x');
    expect(actorInput.context).toBe('ctx');
    expect(actorInput.slotId).toBe(9);
  });

  it('critic receives both the plan and actor output', async () => {
    const passVerdict: PacCriticVerdict = { verdict: 'pass', reason: '', raw: '' };
    const { calls } = setupQueue([
      { defId: 'pac-planner', formatted: 'P' },
      { defId: 'pac-actor', formatted: 'A_OUTPUT' },
      { defId: 'pac-critic', formatted: passVerdict },
    ]);

    await runPAC(fakeCtx(), { task: 'x', slotId: 1 });

    const criticInput = calls.find((c) => c.defId === 'pac-critic')!.input as {
      plan: string;
      actorOutput: string;
    };
    expect(criticInput.plan).toBe('P');
    expect(criticInput.actorOutput).toBe('A_OUTPUT');
  });
});
