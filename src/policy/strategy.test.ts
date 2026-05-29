import { describe, expect, it } from 'vitest';
import { strategyPolicy } from './strategy.js';
import { makePolicyInput } from './test-helpers.js';

describe('strategyPolicy', () => {
  it('returns react with react-mode-flag when reactMode is on', () => {
    const result = strategyPolicy(makePolicyInput({ config: { reactMode: true } }));
    expect(result.id).toBe('react');
    expect(result.reason).toBe('react-mode-flag');
  });

  it('returns normal with react-mode-disabled when reactMode is off', () => {
    const result = strategyPolicy(makePolicyInput({ config: { reactMode: false } }));
    expect(result.id).toBe('normal');
    expect(result.reason).toBe('react-mode-disabled');
  });
});
