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
import { getCachedLLM, setCachedLLM, type LLMCacheKey } from './llm-cache.js';
import { resolveSiteModel } from './model-policy.js';
import type { ProvenanceStore, SourceItem } from './provenance.js';
import type { Check } from './rubric.js';
import { parseStructuredOutput } from './structured-output.js';
import { usageRecordFromSite } from './framework/hooks/token-stats.js';
import type { UsageRecord } from './framework/hooks/token-stats.js';

/** One factual claim, as the research agent reports it. */
export interface Claim {
  /** The sentence being asserted. */
  text: string;
  /** Source ids the claim rests on. */
  sourceIds: string[];
  /** A span the claim says appears verbatim in one of those sources. */
  quote?: string;
}

export interface VerifyClaimsResult {
  /** Worst-of across every claim: any fail → fail, any warn → warn, else pass. */
  verdict: 'pass' | 'warn' | 'fail';
  /** One entry per claim, for the turn rubric. */
  checks: Check[];
}

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
  return `CLAIM:\n${claim.text}\n\nSOURCE TEXT:\n${rendered}`;
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
  opts: { abortSignal?: AbortSignal; onUsage?: (r: UsageRecord) => void } = {},
): Promise<VerifyClaimsResult> {
  if (claims.length === 0) {
    // No claims is not a pass. An answer that asserts nothing checkable has
    // nothing to verify, and the caller decides whether that is acceptable.
    return { verdict: 'warn', checks: [] };
  }

  const checks = await Promise.all(
    claims.map((claim, i) => verifyOne(claim, i, provenance, config, opts)),
  );
  const verdict = checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'pass';
  debugLog('claim-verifier:result', { claims: claims.length, verdict });
  return { verdict, checks };
}

async function verifyOne(
  claim: Claim,
  index: number,
  provenance: ProvenanceStore,
  config: BernardConfig,
  opts: { abortSignal?: AbortSignal; onUsage?: (r: UsageRecord) => void },
): Promise<Check> {
  const id = `claim_${index + 1}`;
  const label = claim.text.slice(0, 120);

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
      evidence: `Quoted text does not appear in ${sources.map((s) => s.id).join(', ')}: "${claim.quote.slice(0, 120)}"`,
    };
  }

  const site = resolveSiteModel(config, 'claim-verifier');
  const userContent = buildUserContent(claim, sources);
  const cacheKey: LLMCacheKey | null =
    config.cacheEnabled !== false
      ? {
          siteName: 'claim-verifier',
          modelId: site.model.modelId,
          providerOptions: site.providerOptions,
          params: site.params,
          system: SYSTEM_PROMPT,
          userContent,
        }
      : null;

  try {
    let rawText: string;
    const cached = cacheKey ? getCachedLLM(cacheKey) : undefined;
    if (cached !== undefined) {
      debugLog('cache:llm:hit', { site: 'claim-verifier' });
      rawText = cached;
    } else {
      if (cacheKey) debugLog('cache:llm:miss', { site: 'claim-verifier' });
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
      opts.onUsage?.(
        usageRecordFromSite(site, 'claim-verifier', result.usage, result.providerMetadata, {
          latencyMs: Date.now() - t0,
        }),
      );
      rawText = result.text;
      if (cacheKey && rawText) setCachedLLM(cacheKey, rawText);
    }

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
