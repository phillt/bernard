import { describe, it, expect, vi, beforeEach } from 'vitest';

// Deterministic fake embeddings: map known phrases to fixed unit vectors so we
// can assert similarity behavior without loading the real model. cosineSimilarity
// is the real implementation (imported via importActual).
const VECTORS: Record<string, number[]> = {
  'what is rust': [1, 0, 0],
  'what is rust?': [0.999, 0.04, 0], // near-identical → above threshold
  'how do i bake bread': [0, 1, 0], // orthogonal → miss
};

const embedSpy = vi.fn(async (texts: string[]) => texts.map((t) => VECTORS[t] ?? [0, 0, 1]));

vi.mock('./embeddings.js', async () => {
  const actual = await vi.importActual<typeof import('./embeddings.js')>('./embeddings.js');
  return {
    ...actual,
    getEmbeddingProvider: vi.fn(async () => ({
      embed: embedSpy,
      dimensions: () => 3,
    })),
  };
});

import { SemanticResponseCache } from './semantic-cache.js';

describe('SemanticResponseCache (#269)', () => {
  let cache: SemanticResponseCache;
  beforeEach(() => {
    cache = new SemanticResponseCache();
    embedSpy.mockClear();
  });

  it('returns null on an empty cache', async () => {
    expect(await cache.get('what is rust')).toBeNull();
  });

  it('returns the stored answer for a near-identical query (above threshold)', async () => {
    await cache.put('what is rust', 'Rust is a systems language.');
    expect(await cache.get('what is rust?')).toBe('Rust is a systems language.');
  });

  it('misses for a semantically different query', async () => {
    await cache.put('what is rust', 'Rust is a systems language.');
    expect(await cache.get('how do i bake bread')).toBeNull();
  });

  it('respects a custom (very high) threshold — near matches no longer hit', async () => {
    const strict = new SemanticResponseCache(10 * 60 * 1000, 0.999999);
    await strict.put('what is rust', 'answer');
    expect(await strict.get('what is rust?')).toBeNull();
  });

  it('expires entries past their TTL', async () => {
    const ttl0 = new SemanticResponseCache(-1); // already expired on insert
    await ttl0.put('what is rust', 'answer');
    expect(await ttl0.get('what is rust')).toBeNull();
  });

  it('does not store empty responses', async () => {
    await cache.put('what is rust', '   ');
    expect(cache.size()).toBe(0);
  });

  it('embeds a query only once across a miss get() + put() in the same turn', async () => {
    expect(await cache.get('what is rust')).toBeNull(); // empty → no embed
    await cache.put('what is rust', 'Rust is a systems language.'); // embeds once, memoized
    embedSpy.mockClear();
    // A second get for the same query reuses the memoized embedding (no new embed).
    expect(await cache.get('what is rust')).toBe('Rust is a systems language.');
    expect(embedSpy).not.toHaveBeenCalled();
  });
});
