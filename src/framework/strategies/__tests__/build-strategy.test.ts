import { describe, it, expect, vi } from 'vitest';
import { buildStrategy } from '../build-strategy.js';
import { NormalStrategy } from '../normal.js';
import { ReActStrategy } from '../react.js';
import type { BernardConfig } from '../../../config.js';
import type { StrategyContext } from '../types.js';

function makeConfig(overrides: Partial<BernardConfig> = {}): BernardConfig {
  return { reactMode: false, maxSteps: 25, ...overrides } as BernardConfig;
}

function makeCtx(config: BernardConfig): StrategyContext {
  return {
    config,
    userInput: 'hi',
    iterate: vi.fn(async () => ({}) as any),
  };
}

describe('buildStrategy', () => {
  it('returns NormalStrategy when reactMode is off', () => {
    expect(buildStrategy(makeConfig({ reactMode: false }))).toBeInstanceOf(NormalStrategy);
  });

  it('wraps with ReActStrategy when reactMode is on', () => {
    expect(buildStrategy(makeConfig({ reactMode: true }))).toBeInstanceOf(ReActStrategy);
  });

  it('threads enforcementStepRatio through to ReActStrategy', async () => {
    const config = makeConfig({ reactMode: true, maxSteps: 40 });
    const strategy = buildStrategy(config, { enforcementStepRatio: 0.25 });
    const ctx = makeCtx(config);
    await strategy.run(ctx);
    // initial maxSteps = computeEffectiveMaxSteps(40, true) = clamp(120, ceiling=150) = 120
    expect((ctx.iterate as any).mock.calls[0][0].maxStepsOverride).toBe(120);
  });

  it('reactMode-off path runs iterate once with no overrides', async () => {
    const config = makeConfig({ reactMode: false });
    const strategy = buildStrategy(config);
    const ctx = makeCtx(config);
    await strategy.run(ctx);
    expect((ctx.iterate as any)).toHaveBeenCalledTimes(1);
    expect((ctx.iterate as any).mock.calls[0][0].systemSuffix).toBeUndefined();
  });
});
