/**
 * Claim↔source verification (#417).
 *
 * Checks that each factual claim a research answer makes is actually supported
 * by the source it cites, and that any quoted span really appears in that
 * source. An unsupported claim fails the run rather than shipping.
 *
 * ## Why this is code and not a prompt
 *
 * The measured failure mode is not fabricated URLs — SourceCheckup found ~100%
 * URL validity alongside **55% response-level support**, with ~30% of
 * individual statements unsupported by the page cited. The citation looked
 * right; the page did not say it. Telling a model to check its own citations
 * asks the component that made the error to notice the error, which is exactly
 * the arrangement that produced those numbers. Checking in code is the only
 * shape where an unsupported claim cannot ship regardless of how the model
 * behaves.
 *
 * ## Fails closed
 *
 * Unlike the pre-turn passes (`prompt-rewriter`, `recall-filter`,
 * `reference-resolver`), which fail OPEN because their neutral outcome is
 * simply "today's behaviour", this fails CLOSED: an unparseable verdict, a
 * missing source, or a thrown error all yield `fail`. A verification pass that
 * silently passes when it breaks is worse than no verification pass, because it
 * converts an unchecked answer into an apparently-checked one. Same reasoning
 * as `pac-critic`'s parse handling.
 *
 * ## The quote check is not an LLM call
 *
 * A quoted span is checked by string containment against `SourceItem.verifyText`
 * — deterministic, free, and unable to be talked out of its answer. Only the
 * softer "does this text support this claim" judgement needs a model.
 */

import { generateText } from 'ai';
import { z } from 'zod';
import type { BernardConfig } from './config.js';
import { debugLog, traceLlm } from './logger.js';
import { mapWithConcurrency } from './concurrency.js';
import { resolveSiteModel } from './model-policy.js';
import type { ProvenanceStore, SourceItem } from './provenance.js';
import { verdictOf, type Check } from './rubric.js';
import { parseStructuredOutput } from './structured-output.js';
import { truncate } from './text.js';

/**
 * One factual claim, as the research agent reports it.
 *
 * The schema is the source of truth and {@link Claim} is derived from it, so
 * the runtime check and the type cannot disagree. Validating the ELEMENTS of
 * `sourceIds` matters: a hand-rolled `Array.isArray` guard admits
 * `sourceIds: [{}, 42]`, which then looks up nothing and gets reported as
 * "cited ids no source registered" — a shape error wearing an
 * unsupported-claim failure's clothes.
 */
export const ClaimSchema = z.object({
  text: z.string(),
  sourceIds: z.array(z.string()),
  quote: z.string().optional(),
});

export type Claim = z.infer<typeof ClaimSchema>;

/**
 * Output cap. Enough for a short verdict and reason per claim; small enough
 * that a model cannot spend the budget narrating.
 */
const CLAIM_VERIFIER_MAX_TOKENS = 400;

/**
 * How much of a source is shown to the verifier for one claim.
 *
 * Below `verifyText`'s own 20,000 cap because the whole point is a focused
 * judgement on one claim, and because several claims may cite the same long
 * source in one run.
 */
const SOURCE_WINDOW_CHARS = 6000;

/**
 * Most claims checked in one pass, and how many checks run at once.
 *
 * The fan-out width here is chosen by a MODEL — nothing caps how many claims a
 * research answer reports — and each check is an independent HTTP request with
 * the AI SDK's default 2 retries behind it. Unbounded, one wordy answer inside
 * a 4-way wrapper fan-out becomes a burst of concurrent classifier requests
 * from a process whose own declared dispatch cap is 4.
 *
 * The limit matches `DEFAULT_MAX_CONCURRENT_AGENTS` for the same reason it was
 * chosen there: it is about not hammering a provider, not about throughput.
 */
const MAX_CLAIMS = 40;
const VERIFY_CONCURRENCY = 4;

const VerdictSchema = z.object({
  supported: z.boolean(),
  reason: z.string(),
});

const SYSTEM_PROMPT = `You check whether a source supports a claim. You are not answering the claim, and you are not judging whether it is true in the world — only whether THIS text says it.

Reply with strict JSON and nothing else:
{"supported": true|false, "reason": "<one short sentence>"}

Rules:
- "supported" is true only if the source text states or directly entails the claim. A source that is merely about the same topic does not support it.
- A claim that goes further than the source — more specific, more certain, broader in scope — is NOT supported. Say what the source actually stopped short of.
- Do not use outside knowledge. If the claim is true but this text does not say it, that is not supported.
- Keep "reason" to one sentence naming the specific gap, not a summary of the source.`;

function buildUserContent(claim: Claim, sources: SourceItem[]): string {
  const rendered = sources
    .map((s) => {
      const body = s.verifyText ?? s.contentPreview;
      const dated = s.publishedAt ? ` (published ${s.publishedAt})` : '';
      return `[${s.id}] ${s.label}${dated}\n${body.slice(0, SOURCE_WINDOW_CHARS)}`;
    })
    .join('\n\n---\n\n');
  // Source first, claim last. The source is shared across every claim citing
  // it while the claim text is unique, so putting the claim first makes the
  // only common prefix the system prompt — too short to reach a provider's
  // automatic prefix-cache threshold. This ordering puts system + source in the
  // shared prefix and costs nothing, since the claims are still checked
  // independently.
  return `SOURCE TEXT:\n${rendered}\n\nCLAIM:\n${claim.text}`;
}

/**
 * Checks a quoted span against the retained source text.
 *
 * Whitespace is collapsed on both sides before comparison: markdown conversion
 * rewraps lines, so a span copied faithfully from what the model saw can differ
 * from the stored text by line breaks alone. Nothing else is normalised — the
 * check is meant to be strict about words.
 */
export function quoteAppearsIn(quote: string, sources: SourceItem[]): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const needle = norm(quote);
  if (!needle) return false;
  return sources.some((s) => {
    const hay = s.verifyText ?? s.contentPreview;
    return norm(hay).includes(needle);
  });
}

/**
 * Verifies every claim against its cited sources.
 *
 * One LLM call per claim, at the cheap `claim-verifier` tier. Claims are
 * checked independently and in parallel — a claim's support does not depend on
 * any other claim, and checking them together invites the model to rationalise
 * a weak one from a strong neighbour.
 */
export async function verifyClaims(
  claims: Claim[],
  provenance: ProvenanceStore,
  config: BernardConfig,
  opts: { abortSignal?: AbortSignal } = {},
): Promise<Check[]> {
  const bounded = claims.slice(0, MAX_CLAIMS);
  const checks = await mapWithConcurrency(bounded, VERIFY_CONCURRENCY, (claim, i) =>
    verifyOne(claim, i, provenance, config, opts),
  );
  debugLog('claim-verifier:result', {
    claims: bounded.length,
    dropped: claims.length - bounded.length,
    verdict: verdictOf(checks),
  });
  return checks;
}

async function verifyOne(
  claim: Claim,
  index: number,
  provenance: ProvenanceStore,
  config: BernardConfig,
  opts: { abortSignal?: AbortSignal },
): Promise<Check> {
  const id = `claim_${index + 1}`;
  const label = truncate(claim.text, 120);

  const sources = claim.sourceIds
    .map((sid) => provenance.get(sid))
    .filter((s): s is SourceItem => s !== undefined);

  if (sources.length === 0) {
    // Either the claim cited nothing, or it cited an id that was never
    // registered. Both mean nothing backs it.
    return {
      id,
      label,
      status: 'fail',
      evidence:
        claim.sourceIds.length === 0
          ? 'No source cited.'
          : `Cited ${claim.sourceIds.join(', ')}, which no source in this run registered.`,
    };
  }

  // Deterministic first: a quote that is not in the source is a fail no model
  // needs to weigh in on, and it catches the exact SourceCheckup failure.
  if (claim.quote && !quoteAppearsIn(claim.quote, sources)) {
    return {
      id,
      label,
      status: 'fail',
      evidence: `Quoted text does not appear in ${sources.map((s) => s.id).join(', ')}: "${truncate(claim.quote, 120)}"`,
    };
  }

  const site = resolveSiteModel(config, 'claim-verifier');
  const userContent = buildUserContent(claim, sources);

  // Deliberately NOT routed through the LLM sub-call cache. Its key embeds
  // `userContent` verbatim, and the claim text differs on every call, so the
  // hit rate is structurally zero — while each miss retains a multi-kilobyte
  // key in a Map with no size cap for the life of the session. Every other
  // user of that cache is a once-per-turn pass with a sub-kilobyte payload.
  // Provider-side prefix caching is what makes the repeated source text cheap;
  // see `buildUserContent` for the ordering that enables it.
  try {
    const result = await traceLlm('claim-verifier', site.model.modelId, () =>
      generateText({
        model: site.model,
        providerOptions: site.providerOptions,
        // Before maxTokens so this site's cap stays authoritative (#286).
        ...site.params,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
        maxSteps: 1,
        maxTokens: CLAIM_VERIFIER_MAX_TOKENS,
        abortSignal: opts.abortSignal,
      }),
    );
    const rawText = result.text;

    const parsed = parseStructuredOutput(rawText, VerdictSchema);
    if (!parsed) {
      // Fails closed. A pass here would launder an unchecked claim into a
      // checked one, which is the failure this whole pass exists to prevent.
      debugLog('claim-verifier:parse-failed', { id, raw: rawText.slice(0, 200) });
      return { id, label, status: 'fail', evidence: 'Verifier returned no usable verdict.' };
    }
    return {
      id,
      label,
      status: parsed.supported ? 'pass' : 'fail',
      evidence: `${sources.map((s) => s.id).join(', ')}: ${parsed.reason}`,
    };
  } catch (err) {
    debugLog('claim-verifier:error', {
      id,
      message: err instanceof Error ? err.message : String(err),
    });
    return { id, label, status: 'fail', evidence: 'Verification could not be completed.' };
  }
}
