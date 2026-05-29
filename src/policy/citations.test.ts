import { describe, expect, it } from 'vitest';
import { citationsPolicy } from './citations.js';
import { makePolicyInput } from './test-helpers.js';

describe('citationsPolicy', () => {
  it('is off by default and points at issue #173', () => {
    const result = citationsPolicy(makePolicyInput());
    expect(result.requireForFactualClaims).toBe(false);
    expect(result.reason).toBe('pending-issue-173');
  });
});
