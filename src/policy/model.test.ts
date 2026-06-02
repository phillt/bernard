import { describe, expect, it } from 'vitest';
import { MODEL_COMPONENTS, modelPolicy } from './model.js';
import { makePolicyInput } from './test-helpers.js';

describe('modelPolicy', () => {
  it('resolves each component via the active lineup', () => {
    const result = modelPolicy(makePolicyInput({ config: { provider: 'openai' } }));
    expect(result.reason).toBe('lineup-resolved');
    for (const key of MODEL_COMPONENTS) {
      expect(result.models[key].provider).toBeTruthy();
      expect(result.models[key].model).toBeTruthy();
    }
  });

  it('emits exactly the known component keys (no extras, no gaps)', () => {
    const result = modelPolicy(makePolicyInput());
    expect(Object.keys(result.models).sort()).toEqual([...MODEL_COMPONENTS].sort());
  });
});
