/** What the corpus eval asks, and which document should answer. */
export interface CorpusQuery {
  id: string;
  query: string;
  /** The uri that should come back. */
  answer: string;
  shape: 'prose' | 'identifier' | 'spanning' | 'nonsense';
}

export const CORPUS_QUERIES: CorpusQuery[] = [
  {
    id: 'q-ship-days',
    query: 'which days of the week are acceptable for shipping to production',
    answer: '/handbook.md',
    shape: 'prose',
  },
  {
    id: 'q-review-tone',
    query: 'how should feedback be worded when reviewing a pull request',
    answer: '/policy.md',
    shape: 'prose',
  },
  {
    // The lexical channel's reason to exist: an exact symbol, in one document,
    // that a 384-dim vector cannot single out.
    id: 'q-resolve-site-model',
    query: 'resolveSiteModel',
    answer: '/policy.ts',
    shape: 'identifier',
  },
  {
    id: 'q-quota-code',
    query: 'QUOTA-4417',
    answer: '/handbook.md',
    shape: 'identifier',
  },
  {
    // The measured defence of "restore document order": the question is about
    // rolling back, and the answer sits beside the heading that names it.
    id: 'q-rollback',
    query: 'is there a button for rolling back a deploy',
    answer: '/handbook.md',
    shape: 'spanning',
  },
  {
    // Must return NOTHING. Without a cosine floor before fusion, an RRF score
    // is ~1/61 for any rank-1 document under any query, so this returns the
    // corpus's k most arbitrary chunks and the model reads them as an answer.
    id: 'q-nonsense',
    query: 'tuba repair techniques for marine biologists',
    answer: '',
    shape: 'nonsense',
  },
];
