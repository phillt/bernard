import { describe, expect, it } from 'vitest';
import { isReactEffective } from './effective.js';

describe('isReactEffective', () => {
  it('returns true when policy says "react", regardless of config.reactMode', () => {
    expect(isReactEffective({ reactMode: false }, { strategyId: 'react' })).toBe(true);
    expect(isReactEffective({ reactMode: true }, { strategyId: 'react' })).toBe(true);
  });

  it('returns false when policy says "normal", regardless of config.reactMode', () => {
    expect(isReactEffective({ reactMode: false }, { strategyId: 'normal' })).toBe(false);
    expect(isReactEffective({ reactMode: true }, { strategyId: 'normal' })).toBe(false);
  });

  it('falls back to config.reactMode when no decision is supplied', () => {
    expect(isReactEffective({ reactMode: true })).toBe(true);
    expect(isReactEffective({ reactMode: false })).toBe(false);
  });

  it('falls back to config.reactMode when strategyId is undefined', () => {
    expect(isReactEffective({ reactMode: true }, {})).toBe(true);
    expect(isReactEffective({ reactMode: false }, {})).toBe(false);
  });
});
