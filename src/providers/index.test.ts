import { describe, it, expect, vi } from 'vitest';
import { getModel } from './index.js';

const mockAnthropicModel = { modelId: 'anthropic-mock' };
const mockOpenaiModel = { modelId: 'openai-mock' };
const mockXaiModel = { modelId: 'xai-mock' };

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn(() => mockAnthropicModel),
}));

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn(() => mockOpenaiModel),
}));

vi.mock('@ai-sdk/xai', () => ({
  xai: vi.fn(() => mockXaiModel),
}));

describe('getModel', () => {
  it('dispatches to anthropic SDK', () => {
    const model = getModel('anthropic', 'claude-sonnet-4-5-20250929');
    expect(model).toBe(mockAnthropicModel);
  });

  it('dispatches to openai SDK', () => {
    const model = getModel('openai', 'gpt-4o');
    expect(model).toBe(mockOpenaiModel);
  });

  it('dispatches to xai SDK', () => {
    const model = getModel('xai', 'grok-3');
    expect(model).toBe(mockXaiModel);
  });

  it('throws for unknown provider', () => {
    expect(() => getModel('unknown', 'model')).toThrow(/Unknown provider/);
  });
});
