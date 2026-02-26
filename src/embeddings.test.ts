import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cosineSimilarity, getEmbeddingProvider, _resetEmbeddingProvider } from './embeddings.js';

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
}));

const mockExtractor = vi.fn().mockResolvedValue({
  data: new Float32Array(384), // single embedding of zeros
  dims: [1, 384],
});

vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(mockExtractor),
}));

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('returns 0 for zero-length vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  it('computes correct value for non-trivial vectors', () => {
    // cos(45°) ≈ 0.7071
    const a = [1, 0];
    const b = [1, 1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(Math.SQRT1_2, 4);
  });
});

describe('getEmbeddingProvider', () => {
  beforeEach(() => {
    _resetEmbeddingProvider();
  });

  it('returns a valid provider when @xenova/transformers is available', async () => {
    const provider = await getEmbeddingProvider();
    expect(provider).not.toBeNull();
    expect(typeof provider!.embed).toBe('function');
    expect(typeof provider!.dimensions).toBe('function');
    expect(provider!.dimensions()).toBe(384);
  });

  it('caches the provider on subsequent calls', async () => {
    const first = await getEmbeddingProvider();
    const second = await getEmbeddingProvider();
    expect(first).toBe(second);
  });
});
