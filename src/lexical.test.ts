import { describe, it, expect } from 'vitest';
import {
  lexicalTokens,
  LexicalIndex,
  namesASymbol,
  reciprocalRankFusion,
  RRF_K,
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

describe('namesASymbol — the gate that makes fusion a strict improvement', () => {
  // Ungated, fusion recovered both identifier misses AND collapsed paraphrase
  // MRR from 0.75 to 0.22 on the eval corpus, because a paraphrase query shares
  // only ordinary words with its answer. No RRF constant and no channel weight
  // separated the two.
  //
  // **The first gate was statistical and was a fixture artifact.** It required
  // a query term appearing in ≤1% of the corpus. Measured against 3,662 real
  // records the rarest term per query was df 1/3/8 for identifier queries and
  // 4/2/5/2/3/1 for prose — completely overlapping, so no threshold separates
  // them, and at production scale it opened on 6 of 6 prose queries. These
  // cases are the ones that would have caught that, and they are written
  // against query SHAPE, which cannot be right on a fixture and wrong at scale.
  it.each([
    'what did we decide about how the user prefers to be addressed',
    'which days are acceptable for shipping to production',
    'how should I word feedback when reviewing a pull request',
    'tell me about the deployment process we agreed on',
    'remind me what we said about handling errors gracefully',
  ])('stays shut for prose: %s', (q) => {
    expect(namesASymbol(q)).toBe(false);
  });

  it.each([
    ['camelCase', 'what happens in resolveSiteModel when there is no role'],
    ['a code with digits', 'I am seeing TS2554 after pulling'],
    ['a dotted filename', 'where is applet-hosts.json written'],
    ['SCREAMING_SNAKE', 'does BERNARD_STREAM_STALL_TIMEOUT_MS cover the header wait'],
    ['a hyphenated code', 'what is QUOTA-4417'],
  ])('opens for %s', (_kind, q) => {
    expect(namesASymbol(q)).toBe(true);
  });

  it('reads the query only, so it cannot depend on corpus size', () => {
    // The property the frequency gate lacked: it is a pure function of the
    // query, so a result measured on a fixture holds in production.
    expect(namesASymbol('resolveSiteModel')).toBe(true);
    expect(namesASymbol('deployment')).toBe(false);
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
