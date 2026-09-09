import { cosineSimilarity } from '../embeddings.js';
import type { EmbeddingProvider } from '../embeddings.js';
import { namesASymbol, reciprocalRankFusion, RRF_K } from '../lexical.js';
import type { KnowledgeCorpus } from './corpus.js';
import type { ChunkKey, ChunkRow, KnowledgeStore } from './store.js';
import { mergeWindows, stitchWindow } from './stitch.js';

/**
 * Retrieval over a knowledge corpus (#516) — dense plus lexical, fused by RRF.
 *
 * Reuses `src/lexical.ts` unchanged: it has zero imports, takes
 * `readonly string[]` and returns array indices, so a second store costs it
 * nothing. A corpus is where that channel matters most — exact identifiers in
 * code and proper nouns in prose are embeddings' documented weak spot, and the
 * conversational store measured identifier recall going 0.75 → 1.00 when it
 * landed.
 */

/** Cosine below which a chunk is not a candidate at all. */
export const DEFAULT_KNOWLEDGE_THRESHOLD = 0.3;
export const DEFAULT_KNOWLEDGE_LIMIT = 5;
/** Chunks of context either side of a hit, restoring document order. */
export const DEFAULT_NEIGHBOURS = 1;
/** Bound on the total text returned, mirroring `web_read`'s output cap. */
export const MAX_RESULT_CHARS = 20_000;
/**
 * Libraries read in one call.
 *
 * Cross-library search reads every in-scope library's vectors and builds one
 * lexical index over all of them, so "many small libraries" is the shape that
 * degrades. Bounded now rather than discovered later.
 */
export const MAX_LIBRARIES_PER_SEARCH = 8;

/**
 * Below this much remaining budget, stop rather than emit a sliver.
 *
 * Applies only from the SECOND hit onward: a first hit is always emitted, so a
 * caller with a small budget gets a short answer rather than an empty one.
 */
export const MIN_USEFUL_EXCERPT_CHARS = 200;

export interface KnowledgeHit {
  library: string;
  uri: string;
  title?: string;
  heading?: string;
  /** The window actually returned, inclusive. */
  ordinals: [number, number];
  /** Stitched, in document order. */
  text: string;
  /**
   * The FUSED rank score. Deliberately a separate field from {@link cosine}: an
   * RRF score is not a similarity and nothing may threshold on it.
   */
  score: number;
  /** The anchor chunk's dense score, on the scale a human reads. */
  cosine: number;
  channels: ('dense' | 'lexical')[];
}

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[];
  /** Libraries actually read. */
  searched: string[];
  /**
   * Libraries excluded for a reason the caller may act on.
   *
   * **Never a fence exclusion.** Naming a library a dispatch was fenced from
   * leaks the corpus catalogue past the fence; a stamp mismatch or a missing
   * file is visible to the same party that could have read the library anyway.
   */
  skipped: { library: string; reason: string }[];
  lexicalUsed: boolean;
  truncated: boolean;
}

export interface KnowledgeSearchOptions {
  limit?: number;
  threshold?: number;
  neighbours?: number;
  /** Restrict to these libraries, on top of whatever the corpus already allows. */
  libraries?: readonly string[];
  maxChars?: number;
}

interface Candidate {
  library: string;
  store: KnowledgeStore;
  chunkId: number;
  sourceId: number;
  ordinal: number;
  cosine: number;
}

export async function searchCorpus(
  corpus: KnowledgeCorpus,
  provider: EmbeddingProvider,
  query: string,
  opts: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult> {
  const limit = opts.limit ?? DEFAULT_KNOWLEDGE_LIMIT;
  const threshold = opts.threshold ?? DEFAULT_KNOWLEDGE_THRESHOLD;
  const neighbours = opts.neighbours ?? DEFAULT_NEIGHBOURS;
  const maxChars = opts.maxChars ?? MAX_RESULT_CHARS;

  // `opts.libraries` narrows on top of the fence; it can never widen it,
  // because `scoped` intersects.
  //
  // **There is no unfenced handle in this module to reach for.**
  // `KnowledgeCorpus` is a TYPE-only import here and nothing constructs one, so
  // every library this function can see arrived through the caller's fence. A
  // mutation replacing this with an unscoped corpus is not expressible, which
  // is the point: the fence is a property of what search is HANDED rather than
  // of remembering to apply it.
  const scoped = opts.libraries ? corpus.scoped(opts.libraries) : corpus;
  const ids = scoped.listIds().slice(0, MAX_LIBRARIES_PER_SEARCH);
  const searched: string[] = [];
  const skipped: KnowledgeSearchResult['skipped'] = [];
  const stores: { id: string; store: KnowledgeStore }[] = [];

  const model = provider.modelId();
  const dimensions = provider.dimensions();
  for (const id of ids) {
    const store = scoped.open(id);
    if (!store) continue;
    const why = store.mismatchReason(model, dimensions);
    if (why) {
      skipped.push({ library: id, reason: why });
      continue;
    }
    stores.push({ id, store });
    searched.push(id);
  }

  const empty: KnowledgeSearchResult = {
    hits: [],
    searched,
    skipped,
    lexicalUsed: false,
    truncated: false,
  };
  if (stores.length === 0 || query.trim().length === 0) return empty;

  const [queryVector] = await provider.embed([query]);

  // One candidate list, two rankings over it. Both channels contribute
  // MEMBERSHIP, and a candidate's index in this array is the currency
  // `reciprocalRankFusion` speaks.
  const candidates: Candidate[] = [];
  const indexByKey = new Map<string, number>();
  const cosineByKey = new Map<string, number>();

  // Takes the candidate itself rather than its six fields spread out: the
  // positional signature had to be re-declared verbatim as a parameter type
  // where `scoreLexically` accepts it, so adding a field to `Candidate` meant
  // editing two places that TypeScript could not relate.
  const admit = (c: Candidate): number => {
    const key = `${c.library}:${c.chunkId}`;
    const existing = indexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = candidates.length;
    candidates.push(c);
    indexByKey.set(key, index);
    return index;
  };

  // ── dense ────────────────────────────────────────────────────────────────
  //
  // The cosine floor applies HERE and only here. It is what stops a query that
  // matches nothing returning the corpus's k most arbitrary chunks: an RRF
  // score is ~1/61 for any rank-1 document under any query, including
  // gibberish, so a threshold on the FUSED score would be meaningless.
  const denseScored: Array<{ index: number; cosine: number }> = [];
  for (const { id, store } of stores) {
    const { vectors } = store.scanVectors(dimensions);
    for (const v of vectors) {
      const cos = cosineSimilarity(queryVector, v.embedding);
      cosineByKey.set(`${id}:${v.id}`, cos);
      if (cos < threshold) continue;
      denseScored.push({
        index: admit({
          library: id,
          store,
          chunkId: v.id,
          sourceId: v.sourceId,
          ordinal: v.ordinal,
          cosine: cos,
        }),
        cosine: cos,
      });
    }
  }
  const denseRanking = denseScored.sort((a, b) => b.cosine - a.cosine).map((d) => d.index);

  // ── lexical ──────────────────────────────────────────────────────────────
  //
  // **Deliberately NOT subject to the cosine floor**, which is `rag.ts`'s rule
  // and its reason: that number means nothing on a BM25 score, and applying it
  // would drop every lexical-ONLY hit — the entire population this channel
  // exists to recover. A lexical-only candidate is admitted with its real
  // cosine, however low.
  //
  // Nothing is lost on the nonsense-query case by leaving the floor off here:
  // `LexicalIndex.score` returns only non-zero scores, so a query whose terms
  // appear nowhere contributes no candidates at all.
  const lexicalUsed = namesASymbol(query);
  const rankings: number[][] = [];
  if (denseRanking.length > 0) rankings.push(denseRanking);
  // Derived from the ranking rather than accumulated into a mutated
  // out-parameter: every `hits.add(i)` was paired with an `out.push(i)` that
  // never separated, so the set was the ranking, stored twice and kept in step
  // by hand.
  const lexicalRanking = lexicalUsed ? scoreLexically(stores, query, cosineByKey, admit) : [];
  const lexicalHits = new Set(lexicalRanking);
  if (lexicalRanking.length > 0) rankings.push(lexicalRanking);
  if (rankings.length === 0) return { ...empty, lexicalUsed };

  const fused = reciprocalRankFusion(rankings);

  // ── windows ──────────────────────────────────────────────────────────────
  //
  // A neighbour pulled in for an earlier hit must not also occupy a rank of its
  // own: that is the same text twice inside one budget, and it collapses the
  // effective result count.
  //
  // Window arithmetic goes through `mergeWindows` rather than being re-derived
  // here, and the difference is behavioural rather than tidiness: that helper
  // coalesces windows that merely ABUT (`from <= to + 1`), while the inline
  // predicate this replaces required strict overlap. Two anchors one ordinal
  // apart therefore survived as separate hits whose windows share a boundary —
  // exactly the "same text charged twice inside one budget" failure the helper
  // exists to prevent, and its tests were pinning behaviour the shipped code
  // did not have.
  const anchors: Array<{
    index: number;
    candidate: Candidate;
    rank: number;
    from: number;
    to: number;
  }> = [];
  for (const [rank, index] of fused.entries()) {
    const c = candidates[index];
    // One anchor at a time, because a rank is only claimed by the FIRST anchor
    // whose window covers a region — merging the whole set up front would lose
    // which candidate each surviving window belongs to.
    const [span] = mergeWindows(
      [{ sourceId: c.sourceId, ordinal: c.ordinal }],
      neighbours,
      neighbours,
    );
    const covered = anchors.some(
      (a) =>
        a.candidate.library === c.library &&
        a.candidate.sourceId === c.sourceId &&
        // `+ 1` on both sides, matching `mergeWindows`: abutting windows are one
        // continuous run of text with nothing between them.
        span.from <= a.to + 1 &&
        span.to + 1 >= a.from,
    );
    if (covered) continue;
    anchors.push({ index, candidate: c, rank, from: span.from, to: span.to });
    if (anchors.length >= limit) break;
  }

  const hits: KnowledgeHit[] = [];
  let used = 0;
  let truncated = false;
  for (const anchor of anchors) {
    const { candidate: c } = anchor;
    const rows = c.store.chunksInRange(c.sourceId, anchor.from, anchor.to);
    if (rows.length === 0) continue;
    // A single-row lookup, not `listSources().find(...)`: that ran a correlated
    // COUNT(*) per source over the whole table, once per hit, to compute a
    // chunk count this loop discards. 2.597 ms -> 0.0038 ms per call at 2,000
    // sources.
    const source = c.store.getSourceById(c.sourceId);
    let text = stitchWindow(rows as ChunkRow[]);
    if (used + text.length > maxChars) {
      // Lowest-ranked hits are cut first: the budget goes to the best answers
      // rather than to whichever happened to be long.
      //
      // **The first hit is always emitted**, sliced if it has to be. A budget
      // too small for a whole window should produce a short answer, not an
      // empty one — returning nothing is indistinguishable from "the corpus has
      // nothing", which is the failure the cosine floor above exists to make
      // meaningful.
      const room = maxChars - used;
      if (hits.length > 0 && room < MIN_USEFUL_EXCERPT_CHARS) {
        truncated = true;
        break;
      }
      text = `${text.slice(0, Math.max(1, room))}\n\n… (truncated)`;
      truncated = true;
    }
    used += text.length;
    hits.push({
      library: c.library,
      uri: source?.uri ?? '',
      ...(source?.title ? { title: source.title } : {}),
      ...(rows[0].heading ? { heading: rows[0].heading } : {}),
      ordinals: [rows[0].ordinal, rows[rows.length - 1].ordinal],
      text,
      score: 1 / (RRF_K + anchor.rank + 1),
      cosine: c.cosine,
      // The index was in hand at the fused loop; `candidates.indexOf(c)` was a
      // linear re-scan for a value already computed.
      channels: lexicalHits.has(anchor.index) ? ['dense', 'lexical'] : ['dense'],
    });
  }

  return { hits, searched, skipped, lexicalUsed, truncated };
}

/**
 * BM25 over every in-scope chunk, translated back into candidate indices.
 *
 * **The translation is the trap.** `reciprocalRankFusion` takes and returns
 * array INDICES, and the lexical index is built over a different array than the
 * dense candidates — so a lexical rank has to be mapped through the chunk id.
 * Invert that and the result is coherent, plausible and entirely wrong, which is
 * the hardest kind of wrong to notice.
 */
function scoreLexically(
  stores: readonly { id: string; store: KnowledgeStore }[],
  query: string,
  cosineByKey: ReadonlyMap<string, number>,
  admit: (c: Candidate) => number,
): number[] {
  // **One index per LIBRARY, cached on the store's write generation**, rather
  // than one built over the union on every search. Measured, building over
  // 5,000 chunks is 672 ms, and it was thrown away at return — 575 ms of a
  // 600 ms symbol-naming search. The per-library split is what makes the cache
  // possible at all: a union index is invalidated by a write to any library.
  //
  // The cost of splitting is that IDF is now per library rather than corpus-
  // wide, so a term common in one library and rare in another scores by its
  // own library's statistics. That is the same granularity `rag.ts` uses
  // (per store, not per domain) and is the right one here: a library is a
  // corpus, and a term's rarity is a property of the corpus it sits in.
  const perLibrary: Array<{
    library: string;
    store: KnowledgeStore;
    position: number;
    row: ChunkKey;
  }> = [];
  const scores: Array<{ at: number; score: number }> = [];
  for (const { id, store } of stores) {
    const { index, rows: keys } = store.lexicalIndex();
    if (keys.length === 0) continue;
    const base = perLibrary.length;
    for (const row of keys)
      perLibrary.push({ library: id, store, position: perLibrary.length, row });
    for (const [position, score] of index.score(query)) {
      scores.push({ at: base + position, score });
    }
  }
  if (perLibrary.length === 0) return [];

  const scored = new Map(scores.map((s) => [s.at, s.score] as const));
  const out: number[] = [];
  for (const [position] of [...scored.entries()].sort((a, b) => b[1] - a[1])) {
    const entry = perLibrary[position];
    out.push(
      admit({
        library: entry.library,
        store: entry.store,
        chunkId: entry.row.id,
        sourceId: entry.row.sourceId,
        ordinal: entry.row.ordinal,
        cosine: cosineByKey.get(`${entry.library}:${entry.row.id}`) ?? 0,
      }),
    );
  }
  return out;
}
