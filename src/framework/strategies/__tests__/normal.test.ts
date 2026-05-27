import { describe, it, expect, vi } from 'vitest';
import { NormalStrategy } from '../normal.js';
import type { StrategyContext } from '../types.js';
import type { BernardConfig } from '../../../config.js';

function makeCtx(iterate: StrategyContext['iterate']): StrategyContext {
  return {
    config: { reactMode: false, maxSteps: 25 } as BernardConfig,
    userInput: 'hi',
    iterate,
  };
}

describe('NormalStrategy', () => {
  it('invokes iterate exactly once with empty extras', async () => {
    const iterate = vi.fn(async () => ({ text: 'ok' }) as any);
    const result = await new NormalStrategy().run(makeCtx(iterate));
    expect(iterate).toHaveBeenCalledTimes(1);
    expect(iterate).toHaveBeenCalledWith({ extra: [] });
    expect(result).toEqual({ text: 'ok' });
  });

  it('passes no systemSuffix or maxStepsOverride', async () => {
    const iterate = vi.fn(async () => ({}) as any);
    await new NormalStrategy().run(makeCtx(iterate));
    const opts = iterate.mock.calls[0][0];
    expect(opts.systemSuffix).toBeUndefined();
    expect(opts.maxStepsOverride).toBeUndefined();
  });
});
