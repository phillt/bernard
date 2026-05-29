import { describe, expect, it } from 'vitest';
import { MODEL_COMPONENTS, modelPolicy } from './model.js';
import { makePolicyInput } from './test-helpers.js';

describe('modelPolicy', () => {
  it('mirrors config.provider and config.model for every known component', () => {
    const result = modelPolicy(
      makePolicyInput({ config: { provider: 'openai', model: 'gpt-4o' } }),
    );
    expect(result.reason).toBe('config-default');
    for (const key of MODEL_COMPONENTS) {
      expect(result.models[key]).toEqual({ provider: 'openai', model: 'gpt-4o' });
    }
  });

  it('emits exactly the known component keys (no extras, no gaps)', () => {
    const result = modelPolicy(makePolicyInput());
    expect(Object.keys(result.models).sort()).toEqual([...MODEL_COMPONENTS].sort());
  });
});
