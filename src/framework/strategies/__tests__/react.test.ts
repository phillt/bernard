import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../output.js', () => ({
  printInfo: vi.fn(),
  printWarning: vi.fn(),
}));

import { ReActStrategy } from '../react.js';
import { NormalStrategy } from '../normal.js';
import { PlanStore } from '../../../plan-store.js';
import { REACT_COORDINATOR_PROMPT, REACT_ENFORCEMENT_MAX_RETRIES } from '../../../react.js';
import { printInfo, printWarning } from '../../../output.js';
import type { StrategyContext, IterateOpts } from '../types.js';
import type { BernardConfig } from '../../../config.js';

const baseResult = {
  finishReason: 'stop',
  steps: [],
  response: { messages: [] },
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
} as any;

function makeCtx(
  overrides: Partial<StrategyContext> & { config?: Partial<BernardConfig> } = {},
): StrategyContext & { iterate: ReturnType<typeof vi.fn> } {
  const { config: configOverride, ...rest } = overrides;
  return {
    config: { coordinatorMode: 'on', maxSteps: 10, ...configOverride } as BernardConfig,
    userInput: 'do stuff',
    iterate: vi.fn(async () => baseResult),
    ...rest,
  } as any;
}

beforeEach(() => {
  vi.mocked(printInfo).mockClear();
  vi.mocked(printWarning).mockClear();
});

describe('ReActStrategy', () => {
  it('delegates to inner unchanged when reactMode is off', async () => {
    const inner = new NormalStrategy();
    const innerSpy = vi.spyOn(inner, 'run');
    const ctx = makeCtx({ config: { coordinatorMode: 'off' } });
    await new ReActStrategy(inner).run(ctx);
    expect(innerSpy).toHaveBeenCalledTimes(1);
    expect(ctx.iterate).toHaveBeenCalledTimes(1);
    expect(ctx.iterate.mock.calls[0][0].systemSuffix).toBeUndefined();
    expect(ctx.iterate.mock.calls[0][0].maxStepsOverride).toBeUndefined();
  });

  it('injects coordinator suffix and tripled maxSteps on the initial call', async () => {
    const ctx = makeCtx();
    await new ReActStrategy(new NormalStrategy()).run(ctx);
    const opts = ctx.iterate.mock.calls[0][0] as IterateOpts;
    expect(opts.systemSuffix).toBe(REACT_COORDINATOR_PROMPT);
    expect(opts.maxStepsOverride).toBe(30);
  });

  it('skips enforcement when plan is already complete', async () => {
    const planStore = new PlanStore();
    planStore.create([{ description: 'a', verification: 'b' }]);
    planStore.update(1, 'done', { signoff: 'ok' });
    const ctx = makeCtx({ planStore });
    await new ReActStrategy(new NormalStrategy()).run(ctx);
    expect(ctx.iterate).toHaveBeenCalledTimes(1);
  });

  it('re-prompts to create a plan when the model finished without calling `plan`', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore });
    let call = 0;
    ctx.iterate.mockImplementation(async () => {
      call++;
      // Initial call: model produces no plan. Enforcement retry: model
      // finally calls `plan.create` and resolves the step.
      if (call === 2) {
        planStore.create([{ description: 'a', verification: 'b' }]);
        planStore.update(1, 'done', { signoff: 'ok' });
      }
      return baseResult;
    });
    await new ReActStrategy(new NormalStrategy()).run(ctx);
    expect(ctx.iterate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(printWarning)).toHaveBeenCalledWith(
      expect.stringContaining('ended without a plan'),
    );
    const enforcementOpts = ctx.iterate.mock.calls[1][0] as IterateOpts;
    const lastMsg = enforcementOpts.extra?.[enforcementOpts.extra.length - 1];
    expect(typeof lastMsg?.content === 'string' ? lastMsg.content : '').toContain(
      'did not call the `plan` tool',
    );
  });

  it('exhausts retries when model never creates a plan and logs the give-up', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore });
    // iterate always returns without creating a plan.
    await new ReActStrategy(new NormalStrategy()).run(ctx);
    expect(ctx.iterate).toHaveBeenCalledTimes(1 + REACT_ENFORCEMENT_MAX_RETRIES);
    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(
      expect.stringContaining('without a plan after'),
    );
    expect(planStore.view().length).toBe(0);
  });

  it('re-prompts when plan has unresolved steps, exits when resolved', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore });
    let call = 0;
    ctx.iterate.mockImplementation(async () => {
      call++;
      if (call === 1) planStore.create([{ description: 'a', verification: 'b' }]);
      else planStore.update(1, 'done', { signoff: 'ok' });
      return baseResult;
    });
    await new ReActStrategy(new NormalStrategy()).run(ctx);
    expect(ctx.iterate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(printWarning)).toHaveBeenCalledWith(
      expect.stringContaining('1 unresolved step'),
    );
  });

  it('exhausts retries, auto-cancels remaining steps, prints info', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore });
    ctx.iterate.mockImplementation(async () => {
      if (planStore.view().length === 0)
        planStore.create([{ description: 'stuck', verification: 'check' }]);
      return baseResult;
    });
    await new ReActStrategy(new NormalStrategy()).run(ctx);
    expect(ctx.iterate).toHaveBeenCalledTimes(1 + REACT_ENFORCEMENT_MAX_RETRIES);
    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(expect.stringContaining('Auto-cancelled'));
    const steps = planStore.view();
    expect(steps.every((s) => s.status === 'cancelled')).toBe(true);
  });

  it('stops re-prompting when abort fires mid-loop', async () => {
    const planStore = new PlanStore();
    const ac = new AbortController();
    const ctx = makeCtx({ planStore, abortSignal: ac.signal });
    ctx.iterate.mockImplementation(async () => {
      if (planStore.view().length === 0) {
        planStore.create([{ description: 'never', verification: 'check' }]);
        ac.abort();
      }
      return baseResult;
    });
    await new ReActStrategy(new NormalStrategy()).run(ctx);
    expect(ctx.iterate).toHaveBeenCalledTimes(1);
  });

  it('uses reduced enforcement budget when enforcementStepRatio < 1', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore, config: { coordinatorMode: 'on', maxSteps: 40 } });
    let call = 0;
    ctx.iterate.mockImplementation(async () => {
      call++;
      if (call === 1) planStore.create([{ description: 'a', verification: 'b' }]);
      else planStore.update(1, 'done', { signoff: 'ok' });
      return baseResult;
    });
    await new ReActStrategy(new NormalStrategy(), { enforcementStepRatio: 0.25 }).run(ctx);
    const enforcementOpts = ctx.iterate.mock.calls[1][0] as IterateOpts;
    expect(enforcementOpts.maxStepsOverride).toBe(30);
  });

  it('enforcement budget is relative to config.maxSteps, not baseMaxSteps', async () => {
    // Specialist scenario: config.maxSteps=25, baseMaxSteps=13 (caller halved).
    // Initial call uses tripled baseMaxSteps; enforcement should use
    // ceil(config.maxSteps * 0.25) = 7, tripled = 21 — the historical budget.
    const planStore = new PlanStore();
    const ctx = makeCtx({
      planStore,
      baseMaxSteps: 13,
      config: { coordinatorMode: 'on', maxSteps: 25 },
    });
    let call = 0;
    ctx.iterate.mockImplementation(async () => {
      call++;
      if (call === 1) planStore.create([{ description: 'a', verification: 'b' }]);
      else planStore.update(1, 'done', { signoff: 'ok' });
      return baseResult;
    });
    await new ReActStrategy(new NormalStrategy(), { enforcementStepRatio: 0.25 }).run(ctx);
    expect((ctx.iterate.mock.calls[0][0] as IterateOpts).maxStepsOverride).toBe(39);
    expect((ctx.iterate.mock.calls[1][0] as IterateOpts).maxStepsOverride).toBe(21);
  });

  it('prefixes warnings/info with ctx.prefix when provided', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore, prefix: 'spec:1' });
    ctx.iterate.mockImplementation(async () => {
      if (planStore.view().length === 0)
        planStore.create([{ description: 'stuck', verification: 'check' }]);
      return baseResult;
    });
    await new ReActStrategy(new NormalStrategy()).run(ctx);
    expect(vi.mocked(printWarning)).toHaveBeenCalledWith(expect.stringContaining('[spec:1]'));
    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(expect.stringContaining('[spec:1]'));
  });

  it('does not enforce when stepLimitHit is true', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore, getStepLimitHit: () => true });
    ctx.iterate.mockImplementation(async () => {
      if (planStore.view().length === 0)
        planStore.create([{ description: 'a', verification: 'b' }]);
      return baseResult;
    });
    await new ReActStrategy(new NormalStrategy()).run(ctx);
    expect(ctx.iterate).toHaveBeenCalledTimes(1);
  });
});
