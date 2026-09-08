import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { searchCorpus, DEFAULT_KNOWLEDGE_THRESHOLD } from './search.js';
import { KnowledgeCorpus } from './corpus.js';
import { KnowledgeStore, closeAllKnowledgeStores } from './store.js';
import { knowledgeDir } from '../paths.js';
import type { EmbeddingProvider } from '../embeddings.js';

const DIMS = 3;
const LIBS = ['docs', 'other'];

/**
 * A provider whose vector is decided by which keyword a text contains, so
 * "similar" and "unrelated" are exact rather than approximate — the ranking is
 * what is under test, not the embedder.
 */
const provider: EmbeddingProvider = {
  async embed(texts) {
    return texts.map((t) => {
      if (/lighthouse/i.test(t)) return [1, 0, 0];
      if (/harbour/i.test(t)) return [0.92, 0.39, 0];
      if (/bookkeeping/i.test(t)) return [0, 1, 0];
      // The zero vector, deliberately: `cosineSimilarity` returns 0 for it, so
      // anything with no keyword is dense-invisible. The first version of this
      // fake returned a shared non-zero fallback, which made a nonsense QUERY
      // and an unrelated CHUNK identical — they scored 1.0 against each other
      // and the "returns nothing" test failed for a reason that had nothing to
      // do with the code under test.
      return [0, 0, 0];
    });
  },
  dimensions: () => DIMS,
  modelId: () => 'fake/model-v1',
};

const IDENTITY = { model: 'fake/model-v1', dimensions: DIMS };

async function seed(library: string, chunks: string[]): Promise<KnowledgeStore> {
  const store = new KnowledgeStore(library, IDENTITY);
  const vectors = await provider.embed(chunks);
  store.replaceSource(
    {
      uri: `/${library}.md`,
      title: `${library} doc`,
      kind: 'file',
      contentHash: 'h',
      bytes: 1,
      chunkerVersion: 1,
      chunkTarget: 700,
      ingestedAt: '2026-09-08T00:00:00.000Z',
    },
    chunks.map((text, i) => ({
      ordinal: i,
      text,
      charStart: i * 100,
      charEnd: i * 100 + text.length,
      prefixLen: 0,
      embedding: vectors[i],
    })),
  );
  return store;
}

afterEach(() => {
  closeAllKnowledgeStores();
  for (const id of [...LIBS, 'empty'])
    fs.rmSync(knowledgeDir(id), { recursive: true, force: true });
});

beforeEach(async () => {
  await seed('docs', [
    'Chapter one about the lighthouse keeper.',
    'Chapter two, still the lighthouse, and the resolveSiteModel helper.',
    'Chapter three concerns unrelated bookkeeping.',
    'Chapter four is about the harbour wall.',
  ]);
  await seed('other', ['A separate library mentioning the lighthouse too.']);
  closeAllKnowledgeStores();
});

const corpus = (scope?: string[]) => new KnowledgeCorpus(IDENTITY, scope ?? null);

describe('dense retrieval', () => {
  it('returns the matching chunk', async () => {
    const out = await searchCorpus(corpus(['docs']), provider, 'lighthouse');
    expect(out.hits.length).toBeGreaterThan(0);
    expect(out.hits[0].text).toContain('lighthouse');
    expect(out.searched).toEqual(['docs']);
  });

  it('returns NOTHING for a query that matches nothing', async () => {
    // The loudest silent failure available here. An RRF score is ~1/61 for any
    // rank-1 document under any query including gibberish, so without a cosine
    // floor BEFORE fusion a nonsense query returns the corpus's k most
    // arbitrary chunks, confidently formatted, and the model reads them as an
    // answer.
    const out = await searchCorpus(corpus(['docs']), provider, 'quantum gastronomy');
    expect(out.hits).toEqual([]);
  });

  it('reports the cosine separately from the fused score', async () => {
    // They are different scales and nothing may threshold on the fused one.
    const [hit] = (await searchCorpus(corpus(['docs']), provider, 'lighthouse')).hits;
    expect(hit.cosine).toBeGreaterThanOrEqual(DEFAULT_KNOWLEDGE_THRESHOLD);
    expect(hit.score).toBeLessThan(1);
    expect(hit.score).not.toBe(hit.cosine);
  });
});

describe('the lexical channel', () => {
  it('opens only when the query names a symbol', async () => {
    expect((await searchCorpus(corpus(['docs']), provider, 'the lighthouse')).lexicalUsed).toBe(
      false,
    );
    expect((await searchCorpus(corpus(['docs']), provider, 'resolveSiteModel')).lexicalUsed).toBe(
      true,
    );
  });

  it('recovers a chunk the dense channel scores below the floor', async () => {
    // The population this channel exists for. `resolveSiteModel` embeds to the
    // unrelated vector under this provider, so the dense floor rejects it —
    // applying that floor to the lexical channel too would drop every
    // lexical-only hit, which is rag.ts's stated rule.
    const out = await searchCorpus(corpus(['docs']), provider, 'resolveSiteModel');
    expect(out.hits.length).toBeGreaterThan(0);
    expect(out.hits.some((h) => h.text.includes('resolveSiteModel'))).toBe(true);
  });

  it('still returns nothing for a symbol that appears nowhere', async () => {
    // LexicalIndex.score returns only non-zero scores, so leaving the floor off
    // the lexical channel does not reopen the nonsense-query case.
    const out = await searchCorpus(corpus(['docs']), provider, 'nonexistent_symbol_xyz');
    expect(out.hits).toEqual([]);
  });

  it('marks which channels found a hit', async () => {
    const out = await searchCorpus(corpus(['docs']), provider, 'resolveSiteModel');
    expect(out.hits[0].channels).toContain('lexical');
  });
});

describe('document order', () => {
  it('returns neighbours around the hit', async () => {
    const [hit] = (await searchCorpus(corpus(['docs']), provider, 'harbour', { neighbours: 1 }))
      .hits;
    // Chapter four is the hit; chapter three is its neighbour, and returning it
    // in order is the cheapest measured win in the milestone.
    expect(hit.text).toContain('Chapter three');
    expect(hit.text).toContain('Chapter four');
    expect(hit.ordinals[0]).toBeLessThan(hit.ordinals[1]);
  });

  it('honours neighbours: 0', async () => {
    const [hit] = (await searchCorpus(corpus(['docs']), provider, 'harbour', { neighbours: 0 }))
      .hits;
    expect(hit.ordinals[0]).toBe(hit.ordinals[1]);
  });

  it('does not return one chunk as both a hit and a neighbour', async () => {
    // Two adjacent hits expand into overlapping windows; emitted separately the
    // caller pays for the same text twice and the effective result count
    // collapses.
    const out = await searchCorpus(corpus(['docs']), provider, 'lighthouse', { neighbours: 1 });
    const seen = new Set<string>();
    for (const hit of out.hits) {
      for (let o = hit.ordinals[0]; o <= hit.ordinals[1]; o++) {
        const key = `${hit.uri}:${o}`;
        expect(seen.has(key), `ordinal ${o} of ${hit.uri} returned twice`).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe('the fence', () => {
  it('searches only libraries in scope', async () => {
    const out = await searchCorpus(corpus(['docs']), provider, 'lighthouse');
    expect(out.searched).toEqual(['docs']);
    expect(out.hits.every((h) => h.library === 'docs')).toBe(true);
  });

  it('never names an out-of-scope library in skipped', async () => {
    // Naming it leaks the corpus catalogue past the fence.
    const out = await searchCorpus(corpus(['docs']), provider, 'lighthouse');
    expect(out.skipped.map((s) => s.library)).not.toContain('other');
  });

  it('finds the same text through the other library when scoped to it', async () => {
    // Guards the guard: the fenced test above would pass trivially if 'other'
    // simply had nothing to match.
    const out = await searchCorpus(corpus(['other']), provider, 'lighthouse');
    expect(out.hits.length).toBeGreaterThan(0);
    expect(out.hits[0].library).toBe('other');
  });

  it('returns nothing at all under a deny-all scope', async () => {
    const out = await searchCorpus(corpus([]), provider, 'lighthouse');
    expect(out.hits).toEqual([]);
    expect(out.searched).toEqual([]);
  });
});

describe('a stamp mismatch', () => {
  it('skips the library and says why, rather than returning nothing', async () => {
    const other: EmbeddingProvider = { ...provider, modelId: () => 'different/model' };
    const out = await searchCorpus(corpus(['docs']), other, 'lighthouse');
    expect(out.hits).toEqual([]);
    expect(out.searched).toEqual([]);
    // Refuse, do not discard: silently returning nothing is indistinguishable
    // from a library with nothing to say.
    expect(out.skipped[0].reason).toContain('different/model');
  });
});

describe('bounds', () => {
  it('respects the limit', async () => {
    const out = await searchCorpus(corpus(['docs']), provider, 'lighthouse', {
      limit: 1,
      neighbours: 0,
    });
    expect(out.hits).toHaveLength(1);
  });

  it('caps total characters and says it truncated', async () => {
    // Tight enough that the first hit fits and the second does not — the case
    // the budget exists for. `truncated` is what tells a caller the answer is
    // partial rather than complete.
    const out = await searchCorpus(corpus(['docs']), provider, 'lighthouse', {
      maxChars: 60,
      neighbours: 0,
    });
    expect(out.truncated).toBe(true);
    expect(out.hits).toHaveLength(1);
    expect(out.hits.reduce((n, h) => n + h.text.length, 0)).toBeLessThanOrEqual(60);
  });

  it('emits a sliced first hit rather than nothing on a tiny budget', async () => {
    // A budget too small for even one window produces a SHORT answer, not an
    // empty one — returning nothing is indistinguishable from "the corpus has
    // nothing", which is exactly what the cosine floor exists to make
    // meaningful.
    const out = await searchCorpus(corpus(['docs']), provider, 'lighthouse', {
      maxChars: 20,
      neighbours: 0,
    });
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].text).toContain('truncated');
    expect(out.truncated).toBe(true);
  });

  it('handles an empty query without searching', async () => {
    expect((await searchCorpus(corpus(), provider, '   ')).hits).toEqual([]);
  });
});
