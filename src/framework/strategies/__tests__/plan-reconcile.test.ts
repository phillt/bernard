import { describe, it, expect, vi, beforeEach } from 'vitest';

// See `react.test.ts`: the enforcement loop writes to `debugLog` now, because
// `printWarning` is a bare `console.log` and this runs mid-turn while Ink owns
// the screen.
vi.mock('../../../logger.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  debugLog: vi.fn(),
}));

import { PlanReconcileStrategy } from '../plan-reconcile.js';
import { NormalStrategy } from '../normal.js';
import { PlanStore } from '../../../plan-store.js';
import { REACT_ENFORCEMENT_MAX_RETRIES } from '../../../react.js';
import { debugLog } from '../../../logger.js';
import { baseResult, toolUseResult, makeCtx as makeBaseCtx } from './_harness.js';
import type { StrategyContext } from '../types.js';

/** Normal-turn context — the mode this strategy exists for. */
function makeCtx(overrides: Partial<StrategyContext> = {}): ReturnType<typeof makeBaseCtx> {
  return makeBaseCtx({ config: { coordinatorMode: 'off' }, ...overrides });
}

function strategy(): PlanReconcileStrategy {
  return new PlanReconcileStrategy(new NormalStrategy());
}

beforeEach(() => {
  vi.mocked(debugLog).mockClear();
});

describe('PlanReconcileStrategy (#303)', () => {
  it('passes straight through when no plan store is mounted', async () => {
    // Sub-agents, PAC phases, cron and tool-wrappers never mount `plan`.
    const ctx = makeCtx();
    await strategy().run(ctx);
    expect(ctx.iterate).toHaveBeenCalledTimes(1);
  });

  it('re-prompts a Normal turn that abandoned its plan, then auto-cancels', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore });
    ctx.iterate.mockImplementation(async () => {
      if (planStore.view().length === 0)
        planStore.create([{ description: 'gather', verification: 'check output' }]);
      return baseResult;
    });

    await strategy().run(ctx);

    expect(ctx.iterate).toHaveBeenCalledTimes(1 + REACT_ENFORCEMENT_MAX_RETRIES);
    const steps = planStore.view();
    expect(steps.every((s) => s.status === 'cancelled')).toBe(true);
    expect(steps[0].note).toContain('enforcement retries exhausted');
    expect(vi.mocked(debugLog)).toHaveBeenCalledWith(
      'plan:auto-cancelled',
      expect.objectContaining({ steps: expect.any(Number) }),
    );
  });

  it('stops re-prompting as soon as the model resolves the plan', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore });
    let call = 0;
    ctx.iterate.mockImplementation(async () => {
      call++;
      if (call === 1) planStore.create([{ description: 'gather', verification: 'check' }]);
      else planStore.update(1, 'done', { signoff: 'observed the output' });
      return baseResult;
    });

    await strategy().run(ctx);

    expect(ctx.iterate).toHaveBeenCalledTimes(2);
    expect(planStore.view()[0].status).toBe('done');
  });

  it('does NOT nag a turn that used tools but never created a plan', async () => {
    // Missing-plan enforcement is coordinator-only. Widening it here would
    // re-prompt every trivial Normal turn into planning.
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore });
    ctx.iterate.mockResolvedValue(toolUseResult);

    await strategy().run(ctx);

    expect(ctx.iterate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(debugLog).mock.calls.map((c) => c[0])).not.toContain('plan:enforce');
  });

  it('does not re-prompt when the plan is already fully resolved', async () => {
    const planStore = new PlanStore();
    planStore.create([{ description: 'done thing', verification: 'check' }]);
    planStore.update(1, 'done', { signoff: 'observed the output' });
    const ctx = makeCtx({ planStore });

    await strategy().run(ctx);

    expect(ctx.iterate).toHaveBeenCalledTimes(1);
  });

  it('re-prompts without a coordinator suffix or a step-budget override', async () => {
    // A Normal turn should stay a Normal turn: no multi-KB coordinator prompt
    // injected, no tripled budget.
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore });
    ctx.iterate.mockImplementation(async () => {
      if (planStore.view().length === 0)
        planStore.create([{ description: 'gather', verification: 'check' }]);
      return baseResult;
    });

    await strategy().run(ctx);

    const reprompt = ctx.iterate.mock.calls[1][0];
    expect(reprompt.systemSuffix).toBeUndefined();
    expect(reprompt.maxStepsOverride).toBeUndefined();
    expect(String(reprompt.extra.at(-1).content)).toContain('still has unresolved steps');
  });

  it('suppresses reconciliation when the turn was aborted', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore, abortSignal: { aborted: true } as AbortSignal });
    ctx.iterate.mockImplementation(async () => {
      if (planStore.view().length === 0)
        planStore.create([{ description: 'gather', verification: 'check' }]);
      return baseResult;
    });

    await strategy().run(ctx);

    expect(ctx.iterate).toHaveBeenCalledTimes(1);
  });

  it('suppresses reconciliation when the step limit was hit', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore, getStepLimitHit: () => true });
    ctx.iterate.mockImplementation(async () => {
      if (planStore.view().length === 0)
        planStore.create([{ description: 'gather', verification: 'check' }]);
      return baseResult;
    });

    await strategy().run(ctx);

    expect(ctx.iterate).toHaveBeenCalledTimes(1);
  });

  it('tags enforcement events with the dispatch prefix', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore, prefix: 'sub:1' });
    ctx.iterate.mockImplementation(async () => {
      if (planStore.view().length === 0)
        planStore.create([{ description: 'gather', verification: 'check' }]);
      return baseResult;
    });

    await strategy().run(ctx);

    // The prefix rides the event payload now rather than a printed bracket.
    expect(vi.mocked(debugLog)).toHaveBeenCalledWith(
      'plan:enforce',
      expect.objectContaining({ prefix: 'sub:1' }),
    );
  });
});
