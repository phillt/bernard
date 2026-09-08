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

  it('reshapes output into per-text vectors', async () => {
    mockExtractor.mockResolvedValueOnce({
      data: new Float32Array([...Array(384).fill(1), ...Array(384).fill(2)]),
      dims: [2, 384],
    });
    const provider = await getEmbeddingProvider();
    const results = await provider!.embed(['a', 'b']);
    expect(results).toHaveLength(2);
    expect(results[0]).toHaveLength(384);
    expect(results[0][0]).toBe(1);
    expect(results[1][0]).toBe(2);
  });
});

describe('the model is identifiable, and the ceiling is visible (#520)', () => {
  it('names the model that produced its vectors', async () => {
    // Without this the question "which model wrote this store?" is
    // unanswerable from disk, which is why a swap was silent.
    const { getEmbeddingProvider, EMBEDDING_MODEL_ID } = await import('./embeddings.js');
    const provider = await getEmbeddingProvider();
    if (!provider) return; // no model cached in this environment
    expect(provider.modelId()).toBe(EMBEDDING_MODEL_ID);
  });

  it('states the sequence limit in word pieces, not characters', async () => {
    // 256, not the 512 #520 assumes — and #515/#517/#518 are being shaped
    // around this number, so it is worth pinning rather than inferring.
    const { EMBEDDING_MAX_WORD_PIECES, MAX_EMBED_CHARS } = await import('./embeddings.js');
    expect(EMBEDDING_MAX_WORD_PIECES).toBe(256);
    expect(MAX_EMBED_CHARS).toBe(1024);
  });

  it('warns once when input is past the ceiling', async () => {
    const logger = await import('./logger.js');
    const spy = vi.spyOn(logger, 'debugLog');
    const { getEmbeddingProvider, MAX_EMBED_CHARS, _resetEmbeddingProvider } =
      await import('./embeddings.js');
    _resetEmbeddingProvider();
    const provider = await getEmbeddingProvider();
    if (!provider) return;
    spy.mockClear();
    await provider.embed(['x'.repeat(MAX_EMBED_CHARS + 1)]);
    await provider.embed(['y'.repeat(MAX_EMBED_CHARS + 1)]);
    const warns = spy.mock.calls.filter((c) => c[0] === 'embeddings:truncated');
    // Once per process, because this runs in a loop over every fact.
    expect(warns).toHaveLength(1);
    spy.mockRestore();
  });

  it('stays quiet for input the model can actually read', async () => {
    const logger = await import('./logger.js');
    const spy = vi.spyOn(logger, 'debugLog');
    const { getEmbeddingProvider, _resetEmbeddingProvider } = await import('./embeddings.js');
    _resetEmbeddingProvider();
    const provider = await getEmbeddingProvider();
    if (!provider) return;
    spy.mockClear();
    await provider.embed(['a short fact']);
    expect(spy.mock.calls.filter((c) => c[0] === 'embeddings:truncated')).toHaveLength(0);
    spy.mockRestore();
  });
});
