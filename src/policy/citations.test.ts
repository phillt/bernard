import { describe, expect, it } from 'vitest';
import { citationsPolicy } from './citations.js';
import { makePolicyInput } from './test-helpers.js';

describe('citationsPolicy', () => {
  it('is on by default once issue #173 lands', () => {
    const result = citationsPolicy(makePolicyInput());
    expect(result.requireForFactualClaims).toBe(true);
    expect(result.reason).toBe('issue-173-default-on');
  });
});
