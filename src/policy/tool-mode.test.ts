import { describe, expect, it } from 'vitest';
import { toolModePolicy } from './tool-mode.js';
import { makePolicyInput } from './test-helpers.js';

describe('toolModePolicy', () => {
  it('defaults to write-mode with confirm-on-write', () => {
    const result = toolModePolicy(makePolicyInput());
    expect(result.mode).toBe('write');
    expect(result.requireConfirmForWrite).toBe(true);
    expect(result.reason).toBe('config-default');
  });
});
