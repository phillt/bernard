/**
 * A lexical retrieval channel — BM25 over an in-memory corpus (#526).
 *
 * ## Why this exists at all
 *
 * `RAGStore.search` was pure cosine over 384-dim MiniLM, and there was no
 * lexical channel anywhere in the tree — `tokenize()` in `specialist-matcher`
 * and `verification-tracker` are stop-word bags for Jaccard matching, not
 * indexes.
 *
 * The LIMIT result (arXiv 2508.21038) is a *dimensional impossibility*, not a
 * quality gap: the number of top-k document subsets a single-vector model can
 * return is bounded by embedding dimension. On 50k documents with deliberately
 * trivial queries, BM25 scores R@100 **93.6** against 4.8–10.0 for frontier
 * embedders at 3072–4096 dims. Bernard is at 384, the low end of that curve.
 *
 * The repo had already written this conclusion, in `src/tools/docs.ts`: when
 * search arrives it *"should be LEXICAL — over headings and symbol names — not
 * embeddings: exact-identifier lookup is embeddings' documented weak spot."*
 *
 * ## A leaf, and no dependency
 *
 * No import beyond nothing at all, so `rag.ts` acquires no new edge and this is
 * testable without a store, an embedder or a filesystem. At a few thousand
 * records an in-process index is a rounding error against the cosine scan the
 * same query already pays, and it needs no `node:sqlite` FTS5 — which is
 * #516's territory and would make the highest-value retrieval fix wait for the
 * largest build in the milestone.
 *
 * ## The tokenizer is the whole value
 *
 * Reusing `specialist-matcher.tokenize` would defeat the purpose: it splits on
 * every non-alphanumeric, so `applet-hosts.json` becomes `applet|hosts|json`
 * and the exact term is gone — which is the one thing this channel exists to
 * match. {@link lexicalTokens} emits the **whole identifier and its pieces**,
 * so a query naming `applet-hosts.json` matches on the full term (with maximal
 * IDF, since it appears in one record) while a query about hosts still matches
 * the piece.
 */

/**
 * A small stop list, applied to PIECES only — never to a whole identifier.
 *
 * Deliberately shorter than `specialist-matcher`'s ~120 entries, which drops
 * `get`, `make`, `need` and other words that are content in a retrieval query.
 * BM25's IDF already discounts common terms by construction, so an aggressive
 * stop list buys little and costs recall.
 */
const STOP = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'not',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your',
]);

/** Runs of characters that can form one identifier-ish term. */
const TERM_RE = /[A-Za-z0-9][A-Za-z0-9._\-/]*[A-Za-z0-9]|[A-Za-z0-9]+/g;

/**
 * Tokenizes for retrieval, preserving identifiers **and** their pieces.
 *
 * `applet-hosts.json` → `applet-hosts.json`, `applet`, `hosts`, `json`
 * `resolveSiteModel` → `resolvesitemodel`, `resolve`, `site`, `model`
 * `TS2554` → `ts2554`, `ts`, `2554`
 *
 * Emitting both is what lets one index serve two query shapes: an exact term
 * has maximal IDF because it appears in one document, while a prose query about
 * the same subject still matches on pieces. Splitting only, or preserving only,
 * would serve one and lose the other.
 *
 * Duplicates are kept — BM25 is a term-FREQUENCY model, and de-duplicating here
 * would silently turn it into a set-overlap score.
 */
export function lexicalTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(TERM_RE) ?? []) {
    const whole = raw.toLowerCase();
    out.push(whole);
    for (const piece of splitPieces(raw)) {
      // A piece identical to the whole adds nothing but doubles its term
      // frequency, which would over-weight single-word terms against
      // compound ones.
      if (piece !== whole && piece.length > 1 && !STOP.has(piece)) out.push(piece);
    }
  }
  return out;
}

/** camelCase, snake_case, dot and hyphen boundaries, plus letter/digit splits. */
function splitPieces(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

/**
 * Corpus size below which the lexical channel does not engage at all.
 *
 * IDF is a statement about a population; on a handful of documents there is no
 * population and every term looks rare. See {@link LexicalIndex.hasDiscriminatingTerm}.
 */
export const MIN_CORPUS_FOR_LEXICAL = 20;

/** BM25 term-frequency saturation. The standard default. */
const K1 = 1.2;
/** BM25 length normalization. The standard default. */
const B = 0.75;

interface Posting {
  /** Index into the corpus array this index was built from. */
  doc: number;
  tf: number;
}

/**
 * An inverted index over a fixed corpus. Build once, query many times.
 *
 * Rebuilt rather than maintained incrementally: at a few thousand short records
 * a rebuild is well under the cost of the cosine scan the same query pays, and
 * an incrementally-maintained index is a second source of truth that can drift
 * from the array it describes.
 */
export class LexicalIndex {
  private readonly postings = new Map<string, Posting[]>();
  private readonly lengths: number[] = [];
  private readonly avgLength: number;
  readonly size: number;

  constructor(documents: readonly string[]) {
    this.size = documents.length;
    for (let doc = 0; doc < documents.length; doc++) {
      const tokens = lexicalTokens(documents[doc]);
      this.lengths.push(tokens.length);
      const counts = new Map<string, number>();
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const [term, tf] of counts) {
        let list = this.postings.get(term);
        if (!list) this.postings.set(term, (list = []));
        list.push({ doc, tf });
      }
    }
    const total = this.lengths.reduce((a, b) => a + b, 0);
    this.avgLength = documents.length > 0 ? total / documents.length : 0;
  }

  /**
   * The document frequency below which a term counts as **discriminating**.
   *
   * 1% of the corpus, floored at 1 — so on the 51-record eval fixture it is a
   * term appearing in exactly one document, and on a real 3,662-record store it
   * is a term appearing in at most 36. Relative rather than absolute because an
   * ordinary English word sits at df≈2 in a tiny corpus and df≈2000 in a large
   * one; an absolute threshold would gate correctly at one size and wrongly at
   * the other.
   */
  private get rareBelow(): number {
    return Math.max(1, Math.floor(this.size * 0.01));
  }

  /**
   * Whether `query` names anything rare enough for this channel to be useful.
   *
   * **This gate is the difference between a strict improvement and a
   * regression, and it was measured rather than assumed.** Ungated, fusing BM25
   * with cosine recovered both identifier misses AND destroyed paraphrase
   * ranking — MRR 0.75 → 0.22 on the eval corpus — because a paraphrase query
   * shares only ordinary words with its answer, so BM25's long tail of weak
   * matches occupied ranks that dense retrieval had right. Sweeping the RRF
   * constant and a channel weight could not fix it: every setting that helped
   * identifiers hurt paraphrase, and the two best paraphrase settings destroyed
   * long-tail instead.
   *
   * Gating on rarity separates them cleanly, because it is the same property
   * LIMIT is about: a term appearing in essentially one document is exactly the
   * arbitrary top-k subset a 384-dim space cannot single out, and exactly where
   * BM25's IDF is maximal. A query with no such term has nothing this channel
   * can contribute, so it contributes nothing.
   *
   * Measured with the gate: identifier 0.75/0.75 → 1.00/1.00, long-tail
   * 0.00/0.00 → 1.00/0.50, paraphrase and near-duplicate unchanged.
   */
  hasDiscriminatingTerm(query: string): boolean {
    // **Below a floor, rarity is not a signal and the channel stays out.** On a
    // one-document corpus every term appears in 100% of it, yet `df <= 1` calls
    // all of them rare — so the gate opened on every query and BM25 returned
    // the sole record for anything, including queries cosine had rejected as
    // below threshold. Adding a second document then closed the gate and the
    // result vanished, which is how this surfaced: an existing cache test
    // asserting that adding a fact cannot REDUCE what a search returns.
    //
    // 20 is where "appears in one document" first means something: at that size
    // df=1 is 5% of the corpus, and below it the whole store fits in a couple
    // of result pages anyway, so dense retrieval alone is adequate.
    if (this.size < MIN_CORPUS_FOR_LEXICAL) return false;
    const limit = this.rareBelow;
    for (const term of new Set(lexicalTokens(query))) {
      const list = this.postings.get(term);
      if (list && list.length <= limit) return true;
    }
    return false;
  }

  /**
   * Scores every document that shares at least one term with `query`.
   *
   * Returns only non-zero scores, so a query with no lexical overlap yields an
   * empty map rather than a corpus-sized map of zeros — which matters because
   * the caller fuses ranks, and a zero-score document must not occupy a rank.
   *
   * Callers should consult {@link hasDiscriminatingTerm} first; this method
   * answers what BM25 says, not whether BM25 is worth listening to.
   */
  score(query: string): Map<number, number> {
    const scores = new Map<number, number>();
    if (this.size === 0) return scores;
    const seen = new Set<string>();
    for (const term of lexicalTokens(query)) {
      // A term repeated in the QUERY must not multiply its own contribution;
      // BM25 saturates document frequency, not query frequency.
      if (seen.has(term)) continue;
      seen.add(term);
      const list = this.postings.get(term);
      if (!list) continue;
      // Robertson/Sparck-Jones IDF with the +1 that keeps it non-negative for a
      // term appearing in more than half the corpus. Without it a common term
      // scores NEGATIVE and can push a genuinely matching document below one
      // that shares nothing.
      const idf = Math.log(1 + (this.size - list.length + 0.5) / (list.length + 0.5));
      for (const { doc, tf } of list) {
        const norm = 1 - B + (B * this.lengths[doc]) / (this.avgLength || 1);
        scores.set(doc, (scores.get(doc) ?? 0) + (idf * (tf * (K1 + 1))) / (tf + K1 * norm));
      }
    }
    return scores;
  }
}

/**
 * The RRF constant, and it is **untuned** — stated plainly because #526 asks
 * for exactly that.
 *
 * From the 2009 paper that introduced it: *"k = 60 was fixed during a pilot
 * investigation and not altered during subsequent validation."* Elastic later
 * measured k≈20 as better, and Bruch et al. found RRF sensitive to its
 * parameters — which contradicts both properties it is usually sold on. It is
 * kept at 60 here because it is the recognisable default and this change has
 * no evidence for a different value on our own data; whoever tunes it should do
 * so against `retrieval-eval.test.ts` and record the number they measured.
 */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion over any number of ranked id lists.
 *
 * Rank-based rather than score-based, deliberately: the two channels produce
 * scores on incomparable scales (cosine is bounded in [-1,1]; BM25 is unbounded
 * and corpus-dependent), and normalising them into a shared range requires
 * choosing a normalisation that is itself a tuning parameter. Ranks need none.
 */
export function reciprocalRankFusion(
  rankings: ReadonlyArray<readonly number[]>,
  k: number = RRF_K,
): number[] {
  const fused = new Map<number, number>();
  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      fused.set(ranking[i], (fused.get(ranking[i]) ?? 0) + 1 / (k + i + 1));
    }
  }
  return [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([doc]) => doc);
}
