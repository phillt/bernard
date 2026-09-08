import type { RetrievalShape } from './corpus.js';

/**
 * The labelled query set (#524).
 *
 * Each query names the corpus ids that *should* come back. `shape` says which
 * retrieval behaviour the query is probing, and must match the shape of the
 * records it expects — the runner reports per shape, and a query labelled
 * `identifier` whose answer is a `paraphrase` record would silently move the
 * wrong number.
 *
 * **Queries are written against the record, not from it.** Reusing a record's
 * own wording would measure string equality through an embedder and score ~1.0
 * on everything, which is how a retrieval benchmark ends up unable to fail.
 */
export interface LabelledQuery {
  id: string;
  query: string;
  /** Corpus ids that answer this query. Order is irrelevant; membership is not. */
  relevant: string[];
  shape: Exclude<RetrievalShape, 'filler'>;
}

export const RETRIEVAL_QUERIES: LabelledQuery[] = [
  // ── identifier — an exact symbol appearing in exactly one record ───────────
  //
  // **Sentence-embedded, not bare.** The first cut asked bare identifiers
  // (`resolveSiteModel`) and scored a perfect 1.00/1.00 on cosine alone, which
  // is not the failure #526 describes: a query that is *only* the identifier
  // embeds to a vector dominated by that identifier's own subwords, and the one
  // record containing it verbatim shares them. The documented weak spot is the
  // identifier DILUTED among ordinary words, where its contribution to the
  // composed vector is swamped by the surrounding semantics and the decoy
  // records about the same subject compete on equal terms. One bare query is
  // kept as a control, because users do type them.
  {
    id: 'q-resolve-site-model',
    query: 'what happens in resolveSiteModel when the specialist declares no role at all',
    relevant: ['id-resolve-site-model'],
    shape: 'identifier',
  },
  {
    id: 'q-ts-2554',
    query: 'I am seeing TS2554 after pulling and I am not sure which caller is stale',
    relevant: ['id-error-ts-2554'],
    shape: 'identifier',
  },
  {
    id: 'q-stream-stall-env',
    query: 'does BERNARD_STREAM_STALL_TIMEOUT_MS cover the wait before any bytes arrive',
    relevant: ['id-env-flush-debounce'],
    shape: 'identifier',
  },
  {
    // The control: a bare identifier, which cosine handles well and which must
    // keep working. Without it a lexical channel could regress this case and
    // the shape average would still look like an improvement.
    id: 'q-applet-hosts-json',
    query: 'applet-hosts.json',
    relevant: ['id-applet-host-port'],
    shape: 'identifier',
  },

  // ── paraphrase — different words for the same thing ───────────────────────
  {
    id: 'q-when-to-ship',
    query: 'which days of the week are acceptable for shipping to production',
    relevant: ['para-deploy-window'],
    shape: 'paraphrase',
  },
  {
    id: 'q-feedback-tone',
    query: 'how should I word feedback when reviewing someone else’s pull request',
    relevant: ['para-review-style'],
    shape: 'paraphrase',
  },
  {
    id: 'q-morning-meeting',
    query: 'what time does the team sync in the morning and how long does it run',
    relevant: ['para-standup'],
    shape: 'paraphrase',
  },

  // ── near-duplicate — both are close; only one answers ─────────────────────
  {
    id: 'q-weekly-slack',
    query: 'where does the weekly summary get posted on Slack',
    relevant: ['dup-notify-slack'],
    shape: 'near-duplicate',
  },
  {
    id: 'q-weekly-email',
    query: 'is the weekly summary sent out over email',
    relevant: ['dup-notify-email'],
    shape: 'near-duplicate',
  },

  // ── long-tail — the answering term is past the embedder's ceiling ─────────
  {
    id: 'q-quota-4417',
    query: 'QUOTA-4417',
    relevant: ['tail-buried-quotacode'],
    shape: 'long-tail',
  },
];
