import { describe, expect, it } from 'vitest';
import { isReactEffective, isReactPossible } from './effective.js';

describe('isReactEffective', () => {
  it('returns true when policy says "react", regardless of config.coordinatorMode', () => {
    expect(isReactEffective({ coordinatorMode: 'off' }, { strategyId: 'react' })).toBe(true);
    expect(isReactEffective({ coordinatorMode: 'on' }, { strategyId: 'react' })).toBe(true);
    expect(isReactEffective({ coordinatorMode: 'auto' }, { strategyId: 'react' })).toBe(true);
  });

  it('returns false when policy says "normal", regardless of config.coordinatorMode', () => {
    expect(isReactEffective({ coordinatorMode: 'off' }, { strategyId: 'normal' })).toBe(false);
    expect(isReactEffective({ coordinatorMode: 'on' }, { strategyId: 'normal' })).toBe(false);
    expect(isReactEffective({ coordinatorMode: 'auto' }, { strategyId: 'normal' })).toBe(false);
  });

  it("falls back to config.coordinatorMode === 'on' when no decision is supplied", () => {
    expect(isReactEffective({ coordinatorMode: 'on' })).toBe(true);
    expect(isReactEffective({ coordinatorMode: 'off' })).toBe(false);
    // 'auto' is treated as 'off' for callers that bypass the engine (e.g. specialist sub-agents).
    expect(isReactEffective({ coordinatorMode: 'auto' })).toBe(false);
  });

  it("falls back to config.coordinatorMode === 'on' when strategyId is undefined", () => {
    expect(isReactEffective({ coordinatorMode: 'on' }, {})).toBe(true);
    expect(isReactEffective({ coordinatorMode: 'off' }, {})).toBe(false);
    expect(isReactEffective({ coordinatorMode: 'auto' }, {})).toBe(false);
  });
});

describe('isReactPossible (session-stable tool-set membership, #269)', () => {
  it('is true whenever ReAct could run this session (on or auto), false only for off', () => {
    expect(isReactPossible({ coordinatorMode: 'on' })).toBe(true);
    expect(isReactPossible({ coordinatorMode: 'auto' })).toBe(true);
    expect(isReactPossible({ coordinatorMode: 'off' })).toBe(false);
  });
});
