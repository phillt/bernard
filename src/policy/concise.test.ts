import { describe, expect, it } from 'vitest';
import { concisePolicy } from './concise.js';
import { makePolicyInput } from './test-helpers.js';

describe('concisePolicy', () => {
  it('is disabled by default and points at issue #175', () => {
    const result = concisePolicy(makePolicyInput());
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('pending-issue-175');
  });
});
