import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import {
  RETRIEVAL_CORPUS,
  RETRIEVAL_SHAPES,
  type CorpusShape,
  type RetrievalShape,
} from './fixtures/retrieval/corpus.js';
import { RETRIEVAL_QUERIES } from './fixtures/retrieval/queries.js';
import { getEmbeddingProvider, EMBEDDING_MODEL_ID } from '../embeddings.js';
import { MEMORIES_FILE, RAG_DIR } from '../paths.js';
import { RAGStore, DEFAULT_TOP_K_PER_DOMAIN, type StoredMemories } from '../rag.js';
import { getDomainIds } from '../domains.js';

/**
 * The retrieval eval, and the baseline it guards (#524).
 *
 * ## Why this is a test and not a `scripts/eval-*.ts`
 *
 * #524 assumes an eval means real API calls behind `BERNARD_EVAL=1`. For
 * *retrieval* it does not: the embedder is local and free. Measured —
 * **196 ms** to load MiniLM warm, **209 ms** to embed 200 chunks, **2 ms** per
 * query. The whole file costs well under a second and touches no network.
 *
 * That changes what the baseline is worth. A number somebody runs by hand once
 * is an opinion by the following week; a number CI re-derives on every PR is a
 * regression guard. #526 and #372 both change how `search` ranks, and neither
 * can be judged without this.
 *
 * ## Why the store is seeded from disk rather than through `addFacts`
 *
 * `addFacts` dedups at 0.92 and would **silently drop the `near-duplicate`
 * records this corpus exists to measure**. Worse, it would couple this baseline
 * to #525, which changes exactly that path — and the two are supposed to be
 * independent.
 *
 * So the corpus is written as a stamped `StoredMemories` payload and read back
 * through `RAGStore`'s real `load()`. No new API, no test-only seam on the
 * store, and the on-disk format is exercised as a side effect. `setup-test-home`
 * has already pointed `MEMORIES_FILE` at a throwaway home, so this never sees
 * the user's real store.
 *
 * ## Why `searchWithIds` and not `search`
 *
 * `search()` calls `bumpAccess` on every returned hit — it *mutates*, so a
 * second run would measure a different store than the first. `searchWithIds`
 * does not bump, and carries the ids the labels are written against.
 *
 * ## The shape breakdown is the point
 *
 * A single aggregate hides the failure worth catching: a change can lift mean
 * recall while destroying identifier lookup. Assertions are per shape.
 */

/** How deep a result list counts as a hit. Retrieval feeds a prompt, not a UI. */
const K = 10;

/**
 * Committed baseline, measured on this corpus with **cosine-only** retrieval —
 * i.e. `bernard-1-0-0` as of #524, before #525/#526/#372 touch anything.
 *
 * **Recorded as a floor, not a target.** Embedding is deterministic for a fixed
 * model, so these do not drift on their own; the tolerance band keeps the file
 * from failing on an unrelated MiniLM patch release while still catching a real
 * ranking regression. Update deliberately, in the PR that moves them, with the
 * new numbers in the message.
 *
 * The per-query ranks behind these numbers, for whoever changes them next:
 *
 * | shape | query | rank |
 * | --- | --- | --- |
 * | identifier | `q-resolve-site-model` | 1 |
 * | identifier | `q-ts-2554` | **miss** |
 * | identifier | `q-stream-stall-env` | 1 |
 * | identifier | `q-applet-hosts-json` | 1 (bare-identifier control) |
 * | paraphrase | `q-when-to-ship` | 1 |
 * | paraphrase | `q-feedback-tone` | 4 |
 * | paraphrase | `q-morning-meeting` | 1 |
 * | near-duplicate | `q-weekly-slack` | 1 |
 * | near-duplicate | `q-weekly-email` | 1 |
 * | long-tail | `q-quota-4417` | **miss** |
 *
 * **The two misses are what #526 has to move**, and they fail for different
 * reasons — which is why both shapes exist. `q-ts-2554` misses because the
 * identifier is diluted among ordinary words and the decoys about the same
 * subject outrank the record that contains it verbatim. `q-quota-4417` misses
 * because the term sits past the embedder's 256-word-piece ceiling and is not
 * in the vector at all; a lexical index has no sequence limit, so it is
 * reachable by term match and by nothing else available today.
 *
 * `long-tail` at 0.00 is a floor that cannot regress — its value is as the
 * number a lexical channel must raise, not as a guard.
 */
const BASELINE: Record<RetrievalShape, { recall: number; mrr: number }> = {
  identifier: { recall: 0.75, mrr: 0.75 },
  paraphrase: { recall: 1.0, mrr: 0.75 },
  'near-duplicate': { recall: 1.0, mrr: 1.0 },
  'long-tail': { recall: 0.0, mrr: 0.0 },
};

/** Absolute tolerance on a rate. Generous enough for a patch-level model change. */
const TOLERANCE = 0.15;

interface QueryOutcome {
  queryId: string;
  shape: RetrievalShape;
  /** Did every expected id appear in the top K? */
  recalled: boolean;
  /** 1/rank of the first expected id, or 0 when none appeared. */
  reciprocalRank: number;
  returned: number;
}

let outcomes: QueryOutcome[] = [];

/** Writes the fixture corpus to the test home in the store's own on-disk shape. */
async function seedStore(): Promise<void> {
  const provider = await getEmbeddingProvider();
  if (!provider) throw new Error('retrieval eval: no embedding provider available');
  const vectors = await provider.embed(RETRIEVAL_CORPUS.map((r) => r.fact));
  const now = new Date().toISOString();
  // Typed against the shape the store actually writes, so a schema change is a
  // compile error here rather than a runtime "the fixture corpus did not load".
  const payload: StoredMemories = {
    version: 1,
    model: EMBEDDING_MODEL_ID,
    dimensions: provider.dimensions(),
    memories: RETRIEVAL_CORPUS.map((r, i) => ({
      id: r.id,
      fact: r.fact,
      embedding: Array.from(vectors[i]),
      source: 'retrieval-eval-fixture',
      domain: r.domain,
      createdAt: now,
      accessCount: 0,
      // Far future: `pruneExpired` runs in the constructor, and an expired
      // fixture would make the corpus silently smaller than the file says.
      expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    })),
  };
  fs.mkdirSync(RAG_DIR, { recursive: true });
  fs.writeFileSync(MEMORIES_FILE, JSON.stringify(payload), 'utf-8');
}

/** The two rates, computed once and read by both the table and the assertions. */
function metrics(outs: QueryOutcome[]): { recall: number; mrr: number } {
  if (outs.length === 0) return { recall: 0, mrr: 0 };
  const sum = (pick: (o: QueryOutcome) => number) => outs.reduce((a, o) => a + pick(o), 0);
  return {
    recall: sum((o) => (o.recalled ? 1 : 0)) / outs.length,
    mrr: sum((o) => o.reciprocalRank) / outs.length,
  };
}

beforeAll(async () => {
  await seedStore();
  const store = new RAGStore();
  // Sanity: the seed must survive `load()` — a silently-empty store would make
  // every assertion below pass for the wrong reason.
  expect(store.count(), 'the fixture corpus did not load').toBe(RETRIEVAL_CORPUS.length);

  outcomes = [];
  for (const q of RETRIEVAL_QUERIES) {
    // **Threshold 0, but the production per-domain cap.** Dropping the
    // threshold is deliberate — this measures RANKING, and a threshold silently
    // converts a rank-11 result into an absent one, which is a different
    // question the production defaults already answer.
    //
    // `topKPerDomain` is NOT relaxed, and that was a real bug in the first cut:
    // with `Infinity` the per-domain grouping in `scoreAndRank` never binds, so
    // the eval did not exercise it at all — a mutation inverting the sort that
    // feeds that grouping SURVIVED, because the final re-sort hid it. #526
    // plans to fuse a second channel in front of exactly this grouping, so an
    // eval that skipped it would judge that change blind. Restoring the
    // production cap also made the corpus stricter: `q-ts-2554` went from
    // rank 6 to a miss, which is the realistic outcome.
    const hits = await store.searchWithIds(q.query, {
      threshold: 0,
      topKPerDomain: DEFAULT_TOP_K_PER_DOMAIN,
      maxResults: K,
    });
    const ids = hits.map((h) => h.id);
    const firstRank = ids.findIndex((id) => q.relevant.includes(id)) + 1;
    outcomes.push({
      queryId: q.id,
      shape: q.shape,
      recalled: q.relevant.every((id) => ids.includes(id)),
      reciprocalRank: firstRank > 0 ? 1 / firstRank : 0,
      returned: ids.length,
    });
  }
}, 60_000);

describe('retrieval eval (#524)', () => {
  it('every query set is non-empty and labelled against a record that exists', () => {
    // Guards the guard. Every assertion below is a rate over `outcomes`; if a
    // label named a record that is not in the corpus, the query could never be
    // satisfied and the baseline would encode that mistake as normal.
    const ids = new Set(RETRIEVAL_CORPUS.map((r) => r.id));
    expect(RETRIEVAL_QUERIES.length).toBeGreaterThan(0);
    for (const q of RETRIEVAL_QUERIES) {
      expect(q.relevant.length, `[query: ${q.id}] labels nothing`).toBeGreaterThan(0);
      for (const id of q.relevant) {
        expect(ids.has(id), `[query: ${q.id}] labels unknown record "${id}"`).toBe(true);
      }
      const shapes = q.relevant.map((id) => RETRIEVAL_CORPUS.find((r) => r.id === id)!.shape);
      for (const s of shapes) {
        expect(s, `[query: ${q.id}] shape disagrees with the record it expects`).toBe(q.shape);
      }
    }

    // The corpus docstring claims its domains come from the real registry so
    // that `scoreAndRank`'s per-domain grouping behaves as it does in
    // production, and nothing checked it. A typo'd domain silently creates a
    // one-record domain and changes what the per-domain cap does — which is the
    // mechanism this eval was rebuilt around.
    const domains = new Set(getDomainIds());
    for (const r of RETRIEVAL_CORPUS) {
      expect(domains.has(r.domain), `[record: ${r.id}] unknown domain "${r.domain}"`).toBe(true);
    }
  });

  it('respects the result cap, so a ranking change cannot buy recall with tokens', () => {
    // The floor assertions below can only catch a ranking that got WORSE, so
    // nothing else here would notice a change that quietly returns more —
    // which costs real prompt tokens on every turn.
    //
    // **It does not catch a relaxed `topKPerDomain`, and that is not a gap.**
    // Mutating that to `Infinity` survives every assertion in this file,
    // because `maxResults` bounds the list downstream: the effect is a
    // globally-top-K instead of a domain-balanced top-K, same length. Whether
    // that is better or worse is precisely what the rates below measure, and on
    // this corpus they measure it as neutral. A survivor that the metrics
    // correctly judge neutral is a legitimate survivor, not a blind spot.
    for (const o of outcomes) {
      expect(
        o.returned,
        `[query: ${o.queryId}] returned ${o.returned} results, cap is ${K}`,
      ).toBeLessThanOrEqual(K);
    }
  });

  it('the corpus contains every declared shape, so no row is vacuous', () => {
    const all: CorpusShape[] = [...RETRIEVAL_SHAPES, 'filler'];
    for (const shape of all) {
      expect(
        RETRIEVAL_CORPUS.some((r) => r.shape === shape),
        `[shape: ${shape}] has no records`,
      ).toBe(true);
    }
  });

  it('reports the baseline table', () => {
    const rows: Array<{ shape: string; n: number; 'recall@10': string; mrr: string }> = [];
    for (const shape of Object.keys(BASELINE) as Array<keyof typeof BASELINE>) {
      const outs = outcomes.filter((o) => o.shape === shape);
      const m = metrics(outs);
      rows.push({
        shape,
        n: outs.length,
        'recall@10': m.recall.toFixed(2),
        mrr: m.mrr.toFixed(2),
      });
    }
    const all = metrics(outcomes);
    rows.push({
      shape: 'ALL',
      n: outcomes.length,
      'recall@10': all.recall.toFixed(2),
      mrr: all.mrr.toFixed(2),
    });
    console.table(rows);

    // Asserts something that can fail. `outcomes.length === QUERIES.length` was
    // true by construction — the seed loop pushes exactly once per query with
    // no branch — so this `it()` was a `console.table` wearing a test. Every
    // shape having at least one query is the property the per-shape rows below
    // silently depend on: an empty shape reports 0.00 and passes its floor.
    for (const row of rows) {
      expect(row.n, `[shape: ${row.shape}] has no queries, so its row is vacuous`).toBeGreaterThan(
        0,
      );
    }
  });

  it.each(Object.keys(BASELINE) as Array<keyof typeof BASELINE>)(
    '%s holds its baseline',
    (shape) => {
      const outs = outcomes.filter((o) => o.shape === shape);
      const { recall, mrr } = metrics(outs);
      const t = `[shape: ${shape}] [n: ${outs.length}]`;
      expect(
        recall,
        `${t} recall@${K} ${recall.toFixed(2)} vs baseline ${BASELINE[shape].recall}`,
      ).toBeGreaterThanOrEqual(BASELINE[shape].recall - TOLERANCE);
      expect(
        mrr,
        `${t} MRR ${mrr.toFixed(2)} vs baseline ${BASELINE[shape].mrr}`,
      ).toBeGreaterThanOrEqual(BASELINE[shape].mrr - TOLERANCE);
    },
  );
});
