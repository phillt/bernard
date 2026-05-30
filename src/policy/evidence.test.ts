import { describe, expect, it } from 'vitest';
import { evidencePolicy } from './evidence.js';
import { makePolicyInput } from './test-helpers.js';

describe('evidencePolicy', () => {
  it('is on by default once issue #141 lands', () => {
    const result = evidencePolicy(makePolicyInput());
    expect(result.requireForVerifiedClaims).toBe(true);
    expect(result.reason).toBe('issue-141-default-on');
  });
});
