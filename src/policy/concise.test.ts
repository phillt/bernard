import { describe, expect, it } from 'vitest';
import { concisePolicy } from './concise.js';
import { makePolicyInput } from './test-helpers.js';

describe('concisePolicy', () => {
  it('enables concise shaping with bullet/line caps when config.conciseMode is true', () => {
    const result = concisePolicy(makePolicyInput({ config: { conciseMode: true } }));
    expect(result.enabled).toBe(true);
    expect(result.maxBullets).toBe(6);
    expect(result.maxLines).toBe(12);
    expect(result.reason).toBe('config-on');
  });

  it('disables concise shaping when config.conciseMode is false', () => {
    const result = concisePolicy(makePolicyInput({ config: { conciseMode: false } }));
    expect(result.enabled).toBe(false);
    expect(result.maxBullets).toBeUndefined();
    expect(result.maxLines).toBeUndefined();
    expect(result.reason).toBe('config-off');
  });
});
