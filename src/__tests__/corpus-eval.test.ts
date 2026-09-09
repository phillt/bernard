import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';

/**
 * Committed vectors, keyed by TEXT, so this runs offline and deterministically.
 *
 * Keyed by text rather than by index so editing a fixture string MISSES loudly
 * — an index key would score the edited chunk against a stale vector and report
 * a plausible number for a corpus that no longer exists. `retrieval-eval` made
 * the same call for the same reason.
 */
const fixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/corpus/vectors.json', import.meta.url), 'utf-8'),
) as {
  model: string;
  dimensions: number;
  vectors: Record<string, string>;
};

const decode = (b64: string): number[] => {
  const buf = Buffer.from(b64, 'base64');
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
};
const byText = new Map(Object.entries(fixture.vectors).map(([t, b]) => [t, decode(b)]));

vi.mock('../embeddings.js', async () => {
  const actual = await vi.importActual<typeof import('../embeddings.js')>('../embeddings.js');
  return {
    ...actual,
    getEmbeddingProvider: async () => ({
      embed: async (texts: string[]) =>
        texts.map((t) => {
          const v = byText.get(t);
          if (!v) throw new Error(`corpus eval: no committed vector for ${JSON.stringify(t)}`);
          return v;
        }),
      dimensions: () => fixture.dimensions,
      modelId: () => fixture.model,
      // Absent on purpose: the committed chunk plan was produced with the real
      // tokenizer, so re-verifying here would need it again. Ingestion reports
      // `verified: false` and the assertion below pins that this is the only
      // thing lost.
    }),
  };
});

const { CORPUS_DOCUMENTS, CORPUS_FILLER } = await import('./fixtures/corpus/documents.js');
const { CORPUS_QUERIES } = await import('./fixtures/corpus/queries.js');
const { KnowledgeStore, closeAllKnowledgeStores } = await import('../knowledge/store.js');
const { KnowledgeCorpus } = await import('../knowledge/corpus.js');
const { ingestFiles } = await import('../knowledge/ingest.js');
const { searchCorpus } = await import('../knowledge/search.js');
const { getEmbeddingProvider } = await import('../embeddings.js');
const { knowledgeDir } = await import('../paths.js');

const LIBRARY = 'evalcorpus';
const IDENTITY = { model: fixture.model, dimensions: fixture.dimensions };

/**
 * The corpus retrieval baseline (#516/#517).
 *
 * A SEPARATE file from `retrieval-eval.test.ts`, not a section of it. That one
 * measures 51 conversational facts — short, atomic, one claim each. Corpus
 * chunks are a different population with different length statistics, and
 * folding them together makes one regression look like the other's.
 *
 * Documents go in whole and the chunker runs, because a boundary change that
 * scatters an answer across two chunks is exactly what this exists to catch.
 */
describe('corpus retrieval', () => {
  let corpus: InstanceType<typeof KnowledgeCorpus>;

  beforeAll(async () => {
    const store = new KnowledgeStore(LIBRARY, IDENTITY);
    const provider = (await getEmbeddingProvider())!;
    const outcome = await ingestFiles(
      store,
      provider,
      [...CORPUS_DOCUMENTS, ...CORPUS_FILLER].map((d) => ({
        uri: d.uri,
        kind: 'file' as const,
        text: d.text,
        mode: d.mode,
        bytes: d.text.length,
      })),
    );
    expect(outcome.failed).toEqual([]);
    // The mocked provider cannot count word pieces, so ingestion says so rather
    // than assuming the character estimate held.
    expect(outcome.verified).toBe(false);
    store.close();
    closeAllKnowledgeStores();
    corpus = new KnowledgeCorpus(IDENTITY);
  });

  afterAll(() => {
    closeAllKnowledgeStores();
    fs.rmSync(knowledgeDir(LIBRARY), { recursive: true, force: true });
  });

  /**
   * Baseline, measured on this corpus with cosine + BM25 fused by rarity-gated
   * RRF. Recorded as a floor rather than a target: update deliberately, in the
   * PR that moves it, with the new numbers in the message.
   *
   * | shape | queries | answered at rank 1 |
   * | --- | --- | --- |
   * | prose | 2 | 2 |
   * | identifier | 2 | 2 |
   * | spanning | 1 | 1 |
   * | nonsense | 1 | 0 — returns nothing, which is the pass |
   */
  it.each(CORPUS_QUERIES.filter((q) => q.shape !== 'nonsense'))(
    'answers $id ($shape) from $answer',
    async (q) => {
      const out = await searchCorpus(corpus, (await getEmbeddingProvider())!, q.query, {
        limit: 3,
      });
      expect(out.hits.length, `${q.id} returned nothing`).toBeGreaterThan(0);
      expect(out.hits[0].uri, `${q.id} ranked the wrong document first`).toBe(q.answer);
    },
  );

  it('returns nothing for a query that matches nothing', async () => {
    // The loudest silent failure available. Without the cosine floor applied
    // BEFORE fusion, an RRF score is ~1/61 for any rank-1 document under any
    // query — so this would return the corpus's three most arbitrary chunks,
    // confidently formatted, and the model would read them as an answer.
    const nonsense = CORPUS_QUERIES.find((q) => q.shape === 'nonsense')!;
    const out = await searchCorpus(corpus, (await getEmbeddingProvider())!, nonsense.query, {
      limit: 3,
    });
    expect(out.hits).toEqual([]);
  });

  it('opens the lexical channel only for identifier queries', async () => {
    // The rarity gate, which is what separates "recovers identifiers" from
    // "destroys paraphrase ranking" — measured at 0.75 → 0.22 MRR ungated when
    // it landed on the conversational store.
    for (const q of CORPUS_QUERIES) {
      const out = await searchCorpus(corpus, (await getEmbeddingProvider())!, q.query);
      expect(out.lexicalUsed, `${q.id} gated wrongly`).toBe(q.shape === 'identifier');
    }
  });

  it('finds an identifier through the lexical channel specifically', async () => {
    // Guards the guard: the identifier cases above would pass if the dense
    // channel happened to find them, which would leave the lexical channel
    // untested by this file.
    const out = await searchCorpus(corpus, (await getEmbeddingProvider())!, 'resolveSiteModel');
    expect(out.hits[0].channels).toContain('lexical');
  });

  it('returns the surrounding chunks in document order', async () => {
    // The cheapest measured win in the milestone, and the one that is otherwise
    // an unverified claim: the rollback answer sits beside the heading naming
    // it, so a window is what makes the hit readable.
    // The query comes from the fixture set, not written inline: the mock has a
    // vector only for texts the generator saw, and it throws loudly rather than
    // scoring an ad-hoc string against nothing.
    const spanning = CORPUS_QUERIES.find((q) => q.shape === 'spanning')!;
    const out = await searchCorpus(corpus, (await getEmbeddingProvider())!, spanning.query, {
      neighbours: 1,
      limit: 1,
    });
    const [hit] = out.hits;
    expect(hit.ordinals[1]).toBeGreaterThan(hit.ordinals[0]);
    expect(hit.text.indexOf('Rolling back')).toBeLessThan(hit.text.indexOf('Who to wake'));
  });

  it('never returns one chunk twice across hits', async () => {
    const prose = CORPUS_QUERIES.find((q) => q.shape === 'prose')!;
    const out = await searchCorpus(corpus, (await getEmbeddingProvider())!, prose.query, {
      neighbours: 1,
      limit: 5,
    });
    const seen = new Set<string>();
    for (const hit of out.hits) {
      for (let o = hit.ordinals[0]; o <= hit.ordinals[1]; o++) {
        const key = `${hit.uri}:${o}`;
        expect(seen.has(key), `${key} returned twice`).toBe(false);
        seen.add(key);
      }
    }
  });
});
