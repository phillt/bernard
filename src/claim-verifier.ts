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
import { verdictOf, type Check, type CheckLocation } from './rubric.js';
import { parseStructuredOutput } from './structured-output.js';
import { truncate } from './text.js';
import { usageRecordFromSite, type UsageRecorder } from './framework/hooks/token-stats.js';

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

/**
 * A whitespace-flexible matcher for a quoted span.
 *
 * Markdown conversion rewraps lines, so a span copied faithfully from what the
 * model saw can differ from the stored text by line breaks alone. Each run of
 * whitespace in the quote therefore matches any run in the source; everything
 * else is escaped and matched literally, because the check is meant to be
 * strict about words.
 *
 * Returns a regex rather than a boolean so "does it appear" and "where does it
 * appear" cannot drift apart — {@link quoteAppearsIn} and
 * {@link windowAroundQuote} are the same search.
 */
function quoteMatcher(quote: string): RegExp | null {
  const trimmed = quote.trim();
  if (!trimmed) return null;
  const pattern = trimmed
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(pattern, 'i');
}

/**
 * A quoted span, located in the source that contains it (#549).
 *
 * An alias for {@link CheckLocation} rather than a second declaration of the
 * same five fields. This module already imports from `rubric.ts`, so there was
 * never a dependency reason for the copy — and the assignment that carried one
 * into the other was a `{ ...located }` spread, which is exactly what would
 * have hidden a divergence: adding a field to one side compiles fine.
 */
export type QuoteLocation = CheckLocation;

/**
 * The text of a source that a check should run against.
 *
 * Exported since #549 so `cite locate` uses it rather than re-deriving
 * `verifyText ?? contentPreview`. If the two ever diverged, `locateQuote`'s
 * offsets would index a different string than the window sliced around them —
 * a correct offset with silently wrong surrounding text, which is the one
 * output of `locate` a reader cannot check.
 */
export function sourceBody(s: SourceItem): string {
  return s.verifyText ?? s.contentPreview;
}

/**
 * The slice of `body` to show the entailment model.
 *
 * Centred on the quoted span when there is one, rather than always taking the
 * head. The two checks look at different amounts of text — the quote gate runs
 * against the whole retained source (up to `MAX_VERIFY_TEXT`) while this window
 * is a fraction of it — so a head-only window fails a correctly-sourced claim
 * whose supporting passage sits past it: the quote gate passes, the model is
 * shown a region that does not contain the passage, it answers `supported:
 * false`, and because the pass fails closed the whole run is rejected. Showing
 * the region the quote gate already located removes that whole class of false
 * rejection.
 */
function windowAroundQuote(body: string, quote: string | undefined, located = -1): string {
  if (body.length <= SOURCE_WINDOW_CHARS) return body;
  // A local rather than a reassigned parameter: `located` is the offset the
  // quote gate already found in THIS source, and the fallback search below can
  // only fire for the other cited sources — `verifyOne` returns early when a
  // quote is set and nothing matched anywhere.
  const at = located >= 0 ? located : quote ? (body.search(quoteMatcher(quote) ?? /$^/) ?? -1) : -1;
  if (at < 0) return body.slice(0, SOURCE_WINDOW_CHARS);
  // Centre the window on the match, clamped to the ends of the text.
  const start = Math.max(
    0,
    Math.min(at - Math.floor(SOURCE_WINDOW_CHARS / 2), body.length - SOURCE_WINDOW_CHARS),
  );
  const slice = body.slice(start, start + SOURCE_WINDOW_CHARS);
  // Say the text is excerpted, so "the source does not mention X" is understood
  // as being about this window rather than about the whole document.
  return start > 0 ? `…${slice}` : slice;
}

function buildUserContent(claim: Claim, sources: SourceItem[], located?: QuoteLocation): string {
  const rendered = sources
    .map((s) => {
      const dated = s.publishedAt ? ` (published ${s.publishedAt})` : '';
      // The offset is passed through when the quote gate already found it in
      // THIS source, so the window and the gate cannot disagree about where the
      // passage is — which is the drift `quoteMatcher`'s docstring exists to
      // prevent, now closed by sharing the result rather than the regex.
      const at = located?.sourceId === s.id ? located.start : -1;
      return `[${s.id}] ${s.label}${dated}\n${windowAroundQuote(sourceBody(s), claim.quote, at)}`;
    })
    .join('\n\n---\n\n');
  // Source first, claim last. The source is shared across every claim citing
  // it while the claim text is unique, so putting the claim first makes the
  // only common prefix the system prompt — too short to reach a provider's
  // automatic prefix-cache threshold. This ordering puts system + source in the
  // shared prefix and costs nothing, since the claims are still checked
  // independently.
  //
  // Note the window is quote-dependent, so two claims citing one source share
  // the prefix only when they quote the same region — the correctness of
  // showing the model the right passage outranks the caching.
  return `SOURCE TEXT:\n${rendered}\n\nCLAIM:\n${claim.text}`;
}

/**
 * Checks a quoted span against the retained source text.
 *
 * Runs against the WHOLE retained text, not the window shown to the model:
 * this is the deterministic half and there is no reason to limit what it can
 * confirm. {@link windowAroundQuote} is what keeps the model's view aligned
 * with what this found.
 */
export function quoteAppearsIn(quote: string, sources: SourceItem[]): boolean {
  return locateQuote(quote, sources) !== null;
}

/**
 * Where a quoted span sits in the source that contains it (#549).
 *
 * **The location was already computed and thrown away.** {@link quoteMatcher}
 * returns a regex rather than a boolean precisely so "does it appear" and
 * "where does it appear" cannot drift apart, and {@link windowAroundQuote}
 * already calls `body.search(matcher)` — that was the only place in the tree
 * computing a quote's offset, and it discarded it. This makes the answer the
 * return value.
 *
 * `quoteAppearsIn` becomes a thin `!== null` over it, so its existing callers
 * and tests are untouched: the change is to what the search RETURNS, not to
 * what it finds.
 *
 * Sources are checked in the order given, and the first containing source wins.
 * A quote appearing in two cited sources is supported by either; picking the
 * first is stable and needs no rule about which is "better".
 */
export function locateQuote(quote: string, sources: readonly SourceItem[]): QuoteLocation | null {
  const matcher = quoteMatcher(quote);
  if (!matcher) return null;
  for (const source of sources) {
    const body = sourceBody(source);
    const at = body.search(matcher);
    if (at < 0) continue;
    const matched = matcher.exec(body)?.[0] ?? '';
    return {
      sourceId: source.id,
      start: at,
      end: at + matched.length,
      matchedText: matched,
      // Whether the body came from the full retained text or fell back to the
      // 2,000-character preview. A caller checking a long source needs to know
      // that "not found" may mean "not found in the first 2,000 characters" —
      // which is the exact failure `verifyText` exists to prevent, silently
      // reintroduced for the five producers that do not set it.
      fromPreview: source.verifyText === undefined,
    };
  }
  return null;
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
  opts: { abortSignal?: AbortSignal; onUsage?: UsageRecorder } = {},
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
  opts: { abortSignal?: AbortSignal; onUsage?: UsageRecorder },
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
  const sourceIds = sources.map((s) => s.id);
  const located = claim.quote ? locateQuote(claim.quote, sources) : null;
  if (claim.quote && !located) {
    return {
      id,
      label,
      status: 'fail',
      evidence: `Quoted text does not appear in ${sourceIds.join(', ')}: "${truncate(claim.quote, 120)}"`,
      // Structured even on a failure: which sources were checked is the thing a
      // reader needs in order to disagree, and parsing it back out of the
      // sentence above is what a descent affordance would otherwise have to do.
      sources: sourceIds,
    };
  }

  const site = resolveSiteModel(config, 'claim-verifier');
  const userContent = buildUserContent(claim, sources, located ?? undefined);

  // Deliberately NOT routed through the LLM sub-call cache. Its key embeds
  // `userContent` verbatim, and the claim text differs on every call, so the
  // hit rate is structurally zero — while each miss retains a multi-kilobyte
  // key in a Map with no size cap for the life of the session. Every other
  // user of that cache is a once-per-turn pass with a sub-kilobyte payload.
  // Provider-side prefix caching is what makes the repeated source text cheap;
  // see `buildUserContent` for the ordering that enables it.
  try {
    const t0 = Date.now();
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
    // One LLM call per factual sentence is real spend; without this it is
    // invisible to the per-turn odometer and the session ledger, which is how a
    // wordy research answer quietly costs more than the dispatch that produced
    // it.
    opts.onUsage?.(
      usageRecordFromSite(site, 'claim-verifier', result.usage, result.providerMetadata, {
        latencyMs: Date.now() - t0,
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
      evidence: `${sourceIds.join(', ')}: ${parsed.reason}`,
      sources: sourceIds,
      // The span the deterministic gate found, carried through so a caller can
      // go from this verdict to the exact text behind it without re-searching —
      // and without the caller having to know which of the cited sources
      // actually contained the quote.
      ...(located ? { location: located } : {}),
    };
  } catch (err) {
    debugLog('claim-verifier:error', {
      id,
      message: err instanceof Error ? err.message : String(err),
    });
    return { id, label, status: 'fail', evidence: 'Verification could not be completed.' };
  }
}
