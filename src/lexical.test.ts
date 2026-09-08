import { describe, it, expect } from 'vitest';
import {
  lexicalTokens,
  LexicalIndex,
  reciprocalRankFusion,
  RRF_K,
  MIN_CORPUS_FOR_LEXICAL,
} from './lexical.js';

/**
 * The lexical channel (#526). A pure leaf — no store, no embedder, no fs.
 */

describe('lexicalTokens', () => {
  // The whole point of not reusing `specialist-matcher.tokenize`: that one
  // splits on every non-alphanumeric, so the exact term — the thing with
  // maximal IDF and the only thing this channel can match on — disappears.
  it.each([
    ['applet-hosts.json', ['applet-hosts.json', 'applet', 'hosts', 'json']],
    ['resolveSiteModel', ['resolvesitemodel', 'resolve', 'site', 'model']],
    ['TS2554', ['ts2554', 'ts', '2554']],
    ['QUOTA-4417', ['quota-4417', 'quota', '4417']],
    ['snake_case_name', ['snake_case_name', 'snake', 'case', 'name']],
  ])('keeps %s whole and emits its pieces', (input, expected) => {
    expect(lexicalTokens(input)).toEqual(expected);
  });

  it('never emits a piece identical to the whole term', () => {
    // Emitting both would double a single-word term's frequency and over-weight
    // it against a compound one.
    expect(lexicalTokens('deployment')).toEqual(['deployment']);
  });

  it('keeps duplicates, because BM25 is a term-FREQUENCY model', () => {
    // De-duplicating here would silently turn it into a set-overlap score.
    expect(lexicalTokens('deploy deploy')).toEqual(['deploy', 'deploy']);
  });

  it('drops stop words from pieces but never from a whole term', () => {
    expect(lexicalTokens('the deployment')).toEqual(['the', 'deployment']);
    // `for` is a stop word, but `for-each` names something.
    expect(lexicalTokens('for-each')).toEqual(['for-each', 'each']);
  });
});

describe('LexicalIndex', () => {
  const docs = [
    'The function resolveSiteModel is the single source of truth for model selection.',
    'Model resolution for each call site is decided centrally rather than at the site.',
    'Error TS2554 meant a constructor signature had changed underneath a caller.',
    'The build pipeline runs typecheck, lint, format and tests.',
  ];

  it('ranks the document containing the exact term first', () => {
    const idx = new LexicalIndex(docs);
    const ranked = [...idx.score('resolveSiteModel').entries()].sort((a, b) => b[1] - a[1]);
    expect(ranked[0][0]).toBe(0);
  });

  it('returns nothing for a query sharing no terms', () => {
    // Not a map of zeros: the caller fuses RANKS, and a zero-score document
    // must not occupy a rank ahead of a genuine dense hit.
    expect(new LexicalIndex(docs).score('zygote xylophone').size).toBe(0);
  });

  it('is empty and safe on an empty corpus', () => {
    const idx = new LexicalIndex([]);
    expect(idx.size).toBe(0);
    expect(idx.score('anything').size).toBe(0);
    expect(idx.hasDiscriminatingTerm('anything')).toBe(false);
  });

  it('never scores a matching document negative', () => {
    // Robertson/Sparck-Jones IDF goes negative for a term in more than half the
    // corpus. Without the +1 smoothing, a common term would push a genuinely
    // matching document BELOW one that shares nothing.
    const common = Array.from({ length: 10 }, () => 'deployment happens on tuesday');
    const idx = new LexicalIndex(common);
    for (const [, score] of idx.score('deployment')) expect(score).toBeGreaterThan(0);
  });

  it('does not multiply a term repeated in the query', () => {
    const idx = new LexicalIndex(docs);
    const once = idx.score('resolveSiteModel').get(0)!;
    expect(idx.score('resolveSiteModel resolveSiteModel').get(0)).toBeCloseTo(once, 10);
  });
});

describe('hasDiscriminatingTerm — the gate that makes fusion a strict improvement', () => {
  // Measured: ungated fusion recovered both identifier misses AND collapsed
  // paraphrase MRR from 0.75 to 0.22 on the eval corpus, because a paraphrase
  // query shares only ordinary words with its answer. No RRF constant and no
  // channel weight separated the two.
  const corpus = [
    'The function resolveSiteModel decides which model a call site uses.',
    ...Array.from(
      { length: 200 },
      (_, i) => `Routine note ${i} about deployment and configuration.`,
    ),
  ];
  const idx = new LexicalIndex(corpus);

  it('fires for a query naming something rare', () => {
    expect(idx.hasDiscriminatingTerm('what does resolveSiteModel do')).toBe(true);
  });

  it('does not fire for a query of ordinary words', () => {
    expect(idx.hasDiscriminatingTerm('tell me about deployment and configuration')).toBe(false);
  });

  it('scales the threshold with the corpus rather than fixing it', () => {
    // An ordinary English word sits at df≈2 in a tiny corpus and df≈2000 in a
    // large one; an absolute threshold would gate correctly at one size and
    // wrongly at the other. 1% floored at 1 — so on this 201-record corpus a
    // term in one document is discriminating and one in all of them is not.
    expect(idx.hasDiscriminatingTerm('resolveSiteModel')).toBe(true);
    expect(idx.hasDiscriminatingTerm('routine note')).toBe(false);
  });

  it('does not engage at all below the corpus floor', () => {
    // IDF is a statement about a population, and on a handful of documents
    // there is no population — every term appears in ~100% of the corpus while
    // `df <= 1` still calls it rare. Ungated, that made BM25 return the sole
    // record of a one-document store for ANY query, including ones cosine had
    // rejected as below threshold; adding a second document then closed the
    // gate and the result vanished. An existing cache test caught it, asserting
    // that adding a fact cannot reduce what a search returns.
    const tiny = new LexicalIndex(['alpha beta', 'beta gamma']);
    expect(tiny.size).toBeLessThan(MIN_CORPUS_FOR_LEXICAL);
    expect(tiny.hasDiscriminatingTerm('alpha')).toBe(false);

    const atFloor = new LexicalIndex([
      'alpha is unique here',
      ...Array.from({ length: MIN_CORPUS_FOR_LEXICAL - 1 }, (_, i) => `filler note ${i}`),
    ]);
    expect(atFloor.hasDiscriminatingTerm('alpha')).toBe(true);
  });
});

describe('reciprocalRankFusion', () => {
  it('rewards a document ranked well by both channels', () => {
    // b is 2nd and 1st; a is 1st and 3rd. b wins on the sum of reciprocals.
    expect(
      reciprocalRankFusion([
        [1, 2, 3],
        [2, 3, 1],
      ]),
    ).toEqual([2, 1, 3]);
  });

  it('keeps a document only one channel found', () => {
    expect(reciprocalRankFusion([[1], [2]])).toContain(2);
  });

  it('is a no-op shape for a single ranking', () => {
    expect(reciprocalRankFusion([[3, 1, 2]])).toEqual([3, 1, 2]);
  });

  it('exposes its constant as untuned', () => {
    // #526 asks that this be tuned or explicitly documented as an untuned
    // default. It is 60 — the recognisable value from a 2009 paper that says
    // it "was fixed during a pilot investigation and not altered during
    // subsequent validation".
    expect(RRF_K).toBe(60);
  });
});
