import { describe, expect, it } from 'vitest';
import { scratchPolicy } from './scratch.js';
import { makePolicyInput } from './test-helpers.js';

describe('scratchPolicy', () => {
  it('clears the plan store every turn and leaves scratch alone', () => {
    const result = scratchPolicy(makePolicyInput());
    expect(result.resetPlanOnly).toBe(true);
    expect(result.resetAll).toBe(false);
    expect(result.reason).toBe('per-turn-default');
  });
});
