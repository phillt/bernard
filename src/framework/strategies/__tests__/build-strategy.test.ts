import { describe, it, expect, vi } from 'vitest';
import { buildStrategy } from '../build-strategy.js';
import { NormalStrategy } from '../normal.js';
import { ReActStrategy } from '../react.js';
import type { BernardConfig } from '../../../config.js';
import type { StrategyContext } from '../types.js';

function makeConfig(overrides: Partial<BernardConfig> = {}): BernardConfig {
  return { coordinatorMode: 'off', maxSteps: 25, ...overrides } as BernardConfig;
}

function makeCtx(config: BernardConfig): StrategyContext {
  return {
    config,
    userInput: 'hi',
    iterate: vi.fn(async () => ({}) as any),
  };
}

describe('buildStrategy', () => {
  it("returns NormalStrategy when coordinatorMode is 'off'", () => {
    expect(buildStrategy(makeConfig({ coordinatorMode: 'off' }))).toBeInstanceOf(NormalStrategy);
  });

  it("wraps with ReActStrategy when coordinatorMode is 'on'", () => {
    expect(buildStrategy(makeConfig({ coordinatorMode: 'on' }))).toBeInstanceOf(ReActStrategy);
  });

  it('threads enforcementStepRatio through to ReActStrategy', async () => {
    const config = makeConfig({ coordinatorMode: 'on', maxSteps: 40 });
    const strategy = buildStrategy(config, { enforcementStepRatio: 0.25 });
    const ctx = makeCtx(config);
    await strategy.run(ctx);
    // initial maxSteps = computeEffectiveMaxSteps(40, true) = clamp(120, ceiling=150) = 120
    expect((ctx.iterate as any).mock.calls[0][0].maxStepsOverride).toBe(120);
  });

  it('reactMode-off path runs iterate once with no overrides', async () => {
    const config = makeConfig({ coordinatorMode: 'off' });
    const strategy = buildStrategy(config);
    const ctx = makeCtx(config);
    await strategy.run(ctx);
    expect(ctx.iterate as any).toHaveBeenCalledTimes(1);
    expect((ctx.iterate as any).mock.calls[0][0].systemSuffix).toBeUndefined();
  });

  it('opts.strategyId="react" forces ReActStrategy even when config.reactMode is false', () => {
    expect(buildStrategy(makeConfig({ coordinatorMode: 'off' }), { strategyId: 'react' })).toBeInstanceOf(
      ReActStrategy,
    );
  });

  it('opts.strategyId="react" actually injects coordinator prompt at runtime (not just by type)', async () => {
    // Regression for Copilot review: instance-check alone was insufficient
    // because ReActStrategy.run used to short-circuit on ctx.config.reactMode,
    // making the override a runtime no-op despite the right type.
    const config = makeConfig({ coordinatorMode: 'off', maxSteps: 40 });
    const strategy = buildStrategy(config, { strategyId: 'react' });
    const ctx = makeCtx(config);
    await strategy.run(ctx);
    const firstCall = (ctx.iterate as any).mock.calls[0][0];
    expect(firstCall.systemSuffix).toContain('Coordinator Mode');
    expect(firstCall.maxStepsOverride).toBe(120);
  });

  it('opts.strategyId="normal" forces NormalStrategy even when config.reactMode is true', () => {
    expect(buildStrategy(makeConfig({ coordinatorMode: 'on' }), { strategyId: 'normal' })).toBeInstanceOf(
      NormalStrategy,
    );
  });

  it('opts.strategyId="normal" runs as Normal at runtime even with reactMode=true', async () => {
    const config = makeConfig({ coordinatorMode: 'on' });
    const strategy = buildStrategy(config, { strategyId: 'normal' });
    const ctx = makeCtx(config);
    await strategy.run(ctx);
    const firstCall = (ctx.iterate as any).mock.calls[0][0];
    expect(firstCall.systemSuffix).toBeUndefined();
  });
});
