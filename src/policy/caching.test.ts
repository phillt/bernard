import { describe, expect, it } from 'vitest';
import { cachingPolicy } from './caching.js';
import { makePolicyInput } from './test-helpers.js';

describe('cachingPolicy', () => {
  it('is disabled by default and points at issue #171', () => {
    const result = cachingPolicy(makePolicyInput());
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('pending-issue-171');
  });
});
