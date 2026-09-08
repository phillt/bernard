/**
 * The retrieval eval's fixture corpus (#524).
 *
 * **A committed fixture, never the user's live store.** A baseline measured
 * against real memory would move every time the user has a conversation, which
 * makes it a number rather than a regression guard — and it would couple this
 * eval to #525, which changes what gets stored.
 *
 * **`shape` is the point of the file.** A single aggregate recall number hides
 * exactly the failures worth catching: a change can lift the average while
 * destroying identifier lookup. Every record declares which retrieval shape it
 * exists to exercise, and the runner reports per shape.
 *
 * The shapes, and why each is here:
 *
 * - `identifier` — an exact symbol or error code appearing in ONE record.
 *   Embeddings' documented weak spot, and the case #526's lexical channel
 *   exists for: the tokenizer fragments `resolveSiteModel` into subwords whose
 *   composed vector is dominated by its semantic neighbourhood, and a term in
 *   exactly one document is the arbitrary top-k subset LIMIT proves a 384-dim
 *   space cannot single out.
 * - `paraphrase` — the query restates the record in different words. What
 *   cosine is genuinely good at, and the control that stops a lexical channel
 *   being scored as a free win.
 * - `near-duplicate` — two records saying nearly the same thing, where only one
 *   answers the query. Ranking, not recall.
 * - `long-tail` — the answering term sits past the embedder's 256-word-piece
 *   ceiling, so it is invisible to the vector and reachable only lexically.
 * - `filler` — plausible neighbours that must NOT come back. Without these,
 *   recall is trivially 1.0 for any query at any threshold.
 *
 * Domains are drawn from the real registry so `scoreAndRank`'s per-domain
 * grouping behaves as it does in production; the distribution deliberately
 * mirrors a real store's skew rather than being uniform.
 */

/** One fixture record. Mirrors the fields `RAGMemory` needs, minus the vector. */
export interface CorpusRecord {
  id: string;
  fact: string;
  domain: string;
  shape: RetrievalShape;
}

export const RETRIEVAL_SHAPES = [
  'identifier',
  'paraphrase',
  'near-duplicate',
  'long-tail',
  'filler',
] as const;
export type RetrievalShape = (typeof RETRIEVAL_SHAPES)[number];

/** Padding that pushes a record's tail past the embedder's 256-word-piece ceiling. */
const PAST_THE_CEILING = Array.from(
  { length: 120 },
  (_, i) =>
    `Background note ${i + 1} describing routine deployment and configuration details that carry no distinguishing terms.`,
).join(' ');

/**
 * Plausible neighbours, not noise. Random strings would make every query
 * trivially separable and the corpus would measure nothing.
 */
const FILLER_FACTS = [
  'The build pipeline runs typecheck, lint, format and tests on pull request %d.',
  'Configuration for service %d lives beside the deployment manifest.',
  'The model catalogue is refreshed on a 24 hour TTL and cached on disk (note %d).',
  'Session transcripts are retained for a bounded number of sessions, entry %d.',
  'Tool results over the budget are bounded before they enter the context, case %d.',
  'The applet host serves each applet from its own origin, port record %d.',
  'Cron jobs write into a per-job workspace directory, job %d.',
  'A specialist record declares intent and the runtime resolves it, record %d.',
];

export const RETRIEVAL_CORPUS: CorpusRecord[] = [
  // ── identifier ────────────────────────────────────────────────────────────
  {
    id: 'id-resolve-site-model',
    fact: 'The function resolveSiteModel is the single source of truth for which model each call site uses.',
    domain: 'tool-usage',
    shape: 'identifier',
  },
  {
    id: 'id-error-ts-2554',
    fact: 'Error TS2554 in the eval scripts meant a constructor signature had changed underneath them.',
    domain: 'tool-usage',
    shape: 'identifier',
  },
  {
    id: 'id-env-flush-debounce',
    fact: 'BERNARD_STREAM_STALL_TIMEOUT_MS bounds the silence after headers arrive, not the wait for them.',
    domain: 'general',
    shape: 'identifier',
  },
  {
    id: 'id-applet-host-port',
    fact: 'Applet ports are assigned from a hash of the app id and persisted in applet-hosts.json.',
    domain: 'general',
    shape: 'identifier',
  },

  // ── paraphrase ────────────────────────────────────────────────────────────
  {
    id: 'para-deploy-window',
    fact: 'Deployments should not go out on a Friday afternoon; the team prefers Tuesday and Wednesday mornings.',
    domain: 'user-preferences',
    shape: 'paraphrase',
  },
  {
    id: 'para-review-style',
    fact: 'Code review comments should explain the reasoning rather than only naming the rule that was broken.',
    domain: 'user-preferences',
    shape: 'paraphrase',
  },
  {
    id: 'para-standup',
    fact: 'The daily standup happens at quarter past nine and is capped at fifteen minutes.',
    domain: 'general',
    shape: 'paraphrase',
  },

  // ── near-duplicate ────────────────────────────────────────────────────────
  {
    id: 'dup-notify-email',
    fact: 'Send the weekly summary by email on Monday morning.',
    domain: 'user-preferences',
    shape: 'near-duplicate',
  },
  {
    id: 'dup-notify-slack',
    fact: 'Send the weekly summary to Slack on Monday morning.',
    domain: 'user-preferences',
    shape: 'near-duplicate',
  },

  // ── long-tail ─────────────────────────────────────────────────────────────
  {
    id: 'tail-buried-quotacode',
    fact: `Routine operational notes for the reporting pipeline. ${PAST_THE_CEILING} The escalation contact for a QUOTA-4417 breach is the platform on-call rota.`,
    domain: 'general',
    shape: 'long-tail',
  },

  // ── decoys ────────────────────────────────────────────────────────────────
  // **Without these the `identifier` shape is not discriminating**, and the
  // first run of this eval proved it: cosine alone scored identifier 1.00/1.00,
  // because at 50 records a 384-dim space singles out any subset trivially and
  // each identifier was near-unique in vocabulary. LIMIT's impossibility is
  // about combinatorics at scale — it does not reproduce in a toy corpus.
  //
  // Rather than grow to tens of thousands of records, each identifier gets
  // prose neighbours that describe the same subject WITHOUT naming it. That is
  // the mechanism the real failure has: the composed subword vector for
  // `resolveSiteModel` is dominated by its semantic neighbourhood, so the
  // neighbourhood is what has to be present to pull it off the top.
  {
    id: 'decoy-model-resolution-a',
    fact: 'Model resolution for each call site is decided centrally rather than at the site itself.',
    domain: 'tool-usage',
    shape: 'filler',
  },
  {
    id: 'decoy-model-resolution-b',
    fact: 'Which model a site uses is resolved against the active profile on every dispatch.',
    domain: 'tool-usage',
    shape: 'filler',
  },
  {
    id: 'decoy-model-resolution-c',
    fact: 'The single source of truth for site model selection lives in the policy layer.',
    domain: 'tool-usage',
    shape: 'filler',
  },
  {
    id: 'decoy-typescript-error-a',
    fact: 'A TypeScript compiler error about argument counts means a signature changed underneath a caller.',
    domain: 'tool-usage',
    shape: 'filler',
  },
  {
    id: 'decoy-typescript-error-b',
    fact: 'Constructor signature drift in the eval scripts surfaced as a typecheck failure.',
    domain: 'tool-usage',
    shape: 'filler',
  },
  {
    id: 'decoy-stall-timeout-a',
    fact: 'One timeout bounds the wait for response headers; a different one bounds silence mid-stream.',
    domain: 'general',
    shape: 'filler',
  },
  {
    id: 'decoy-stall-timeout-b',
    fact: 'The stream stall guard pauses its clock while a tool is executing.',
    domain: 'general',
    shape: 'filler',
  },
  {
    id: 'decoy-applet-port-a',
    fact: 'Each applet is served from its own origin, and the port is stable across restarts.',
    domain: 'general',
    shape: 'filler',
  },
  {
    id: 'decoy-applet-port-b',
    fact: 'Port assignments for applets are persisted so browser storage survives a reinstall.',
    domain: 'general',
    shape: 'filler',
  },
  {
    id: 'decoy-quota-escalation-a',
    fact: 'Quota breaches escalate to the platform on-call rota rather than the owning team.',
    domain: 'general',
    shape: 'filler',
  },
  {
    id: 'decoy-quota-escalation-b',
    fact: 'The escalation contact for a reporting pipeline breach is documented in the runbook.',
    domain: 'general',
    shape: 'filler',
  },

  // ── filler ────────────────────────────────────────────────────────────────
  ...Array.from({ length: 40 }, (_, i) => ({
    id: `filler-${i}`,
    fact: FILLER_FACTS[i % FILLER_FACTS.length].replace('%d', String(i)),
    domain: (['general', 'conversations', 'tool-usage', 'user-preferences'] as const)[i % 4],
    shape: 'filler' as const,
  })),
];
