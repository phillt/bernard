import { describe, it, expect, vi, beforeEach } from 'vitest';

// `debugLog`, not `output.js` — the enforcement loop writes there now. It used
// to `console.log` mid-turn, which corrupts Ink's live frame, and these tests
// were pinning that in place. See `plan-enforcement.ts`.
vi.mock('../../../logger.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  debugLog: vi.fn(),
}));

import { ReActStrategy } from '../react.js';
import { NormalStrategy } from '../normal.js';
import { PlanStore } from '../../../plan-store.js';
import { REACT_COORDINATOR_PROMPT, REACT_ENFORCEMENT_MAX_RETRIES } from '../../../react.js';
import { debugLog } from '../../../logger.js';
import { baseResult, toolUseResult, makeCtx } from './_harness.js';
import type { IterateOpts } from '../types.js';

beforeEach(() => {
  vi.mocked(debugLog).mockClear();
});

/** Every `debugLog` event name seen so far, for the enforcement assertions. */
const events = (): string[] => vi.mocked(debugLog).mock.calls.map((c) => String(c[0]));

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
      // Initial call: model runs tools but produces no plan. Enforcement
      // retry: model finally calls `plan.create` and resolves the step.
      if (call === 2) {
        planStore.create([{ description: 'a', verification: 'b' }]);
        planStore.update(1, 'done', { signoff: 'ok' });
      }
      return toolUseResult;
    });
    await new ReActStrategy(new NormalStrategy()).run(ctx);
    expect(ctx.iterate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(debugLog)).toHaveBeenCalledWith(
      'plan:enforce',
      expect.objectContaining({ planMissing: true }),
    );
    const enforcementOpts = ctx.iterate.mock.calls[1][0] as IterateOpts;
    const lastMsg = enforcementOpts.extra?.[enforcementOpts.extra.length - 1];
    expect(typeof lastMsg?.content === 'string' ? lastMsg.content : '').toContain(
      'did not call the `plan` tool',
    );
  });

  it('exhausts retries when the model never creates a plan, and records giving up', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore });
    // iterate always runs tools but returns without creating a plan.
    ctx.iterate.mockImplementation(async () => toolUseResult);
    await new ReActStrategy(new NormalStrategy()).run(ctx);
    expect(ctx.iterate).toHaveBeenCalledTimes(1 + REACT_ENFORCEMENT_MAX_RETRIES);
    expect(events()).toContain('plan:none-after-retries');
    expect(planStore.view().length).toBe(0);
  });

  it('skips missing-plan enforcement when the turn used no tools (trivial-turn escape hatch)', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore });
    // No plan AND no tool calls — the model just answered prose. There was
    // nothing to coordinate, so enforcement would only burn LLM calls.
    await new ReActStrategy(new NormalStrategy()).run(ctx);
    expect(ctx.iterate).toHaveBeenCalledTimes(1);
    expect(events()).not.toContain('plan:enforce');
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
    expect(vi.mocked(debugLog)).toHaveBeenCalledWith(
      'plan:enforce',
      expect.objectContaining({ unresolved: 1 }),
    );
  });

  it('exhausts retries and auto-cancels the remaining steps', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore });
    ctx.iterate.mockImplementation(async () => {
      if (planStore.view().length === 0)
        planStore.create([{ description: 'stuck', verification: 'check' }]);
      return baseResult;
    });
    await new ReActStrategy(new NormalStrategy()).run(ctx);
    expect(ctx.iterate).toHaveBeenCalledTimes(1 + REACT_ENFORCEMENT_MAX_RETRIES);
    expect(vi.mocked(debugLog)).toHaveBeenCalledWith(
      'plan:auto-cancelled',
      expect.objectContaining({ steps: 1 }),
    );
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

  it('tags every enforcement event with ctx.prefix when provided', async () => {
    const planStore = new PlanStore();
    const ctx = makeCtx({ planStore, prefix: 'spec:1' });
    ctx.iterate.mockImplementation(async () => {
      if (planStore.view().length === 0)
        planStore.create([{ description: 'stuck', verification: 'check' }]);
      return baseResult;
    });
    await new ReActStrategy(new NormalStrategy()).run(ctx);
    // The prefix still travels; it is a field on the event rather than a
    // bracket glued onto a printed string.
    for (const call of vi.mocked(debugLog).mock.calls) {
      expect(call[1]).toMatchObject({ prefix: 'spec:1' });
    }
    expect(events()).toContain('plan:enforce');
    expect(events()).toContain('plan:auto-cancelled');
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
