import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../output.js', () => ({
  printInfo: vi.fn(),
  printWarning: vi.fn(),
}));

import { PlanReconcileStrategy } from '../plan-reconcile.js';
import { NormalStrategy } from '../normal.js';
import { PlanStore } from '../../../plan-store.js';
import { REACT_ENFORCEMENT_MAX_RETRIES } from '../../../react.js';
import { printInfo, printWarning } from '../../../output.js';
import type { StrategyContext } from '../types.js';
import type { BernardConfig } from '../../../config.js';

const baseResult = {
  finishReason: 'stop',
  steps: [],
  response: { messages: [] },
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
} as any;

// A turn that invoked at least one tool. Only relevant to the "never nag a
// turn into planning" case — missing-plan enforcement is off here by design.
const toolUseResult = {
  ...baseResult,
  steps: [{ toolCalls: [{ toolName: 'shell' }] }],
} as any;

function makeCtx(
  overrides: Partial<StrategyContext> & { config?: Partial<BernardConfig> } = {},
): StrategyContext & { iterate: ReturnType<typeof vi.fn> } {
  const { config: configOverride, ...rest } = overrides;
  return {
    // Normal turn — the whole point of this strategy.
    config: { coordinatorMode: 'off', maxSteps: 10, ...configOverride } as BernardConfig,
    userInput: 'do stuff',
    iterate: vi.fn(async () => baseResult),
    ...rest,
  } as any;
}

function strategy(): PlanReconcileStrategy {
  return new PlanReconcileStrategy(new NormalStrategy());
}

beforeEach(() => {
  vi.mocked(printInfo).mockClear();
  vi.mocked(printWarning).mockClear();
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
    expect(vi.mocked(printInfo).mock.calls.flat().join(' ')).toContain('Auto-cancelled');
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
    expect(printWarning).not.toHaveBeenCalled();
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

  it('tags warnings with the dispatch prefix', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore, prefix: 'sub:1' });
    ctx.iterate.mockImplementation(async () => {
      if (planStore.view().length === 0)
        planStore.create([{ description: 'gather', verification: 'check' }]);
      return baseResult;
    });

    await strategy().run(ctx);

    expect(vi.mocked(printWarning).mock.calls.flat().join(' ')).toContain('[sub:1]');
  });
});
