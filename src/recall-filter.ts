import { generateText, type CoreMessage } from 'ai';
import { debugLog, traceLlm } from './logger.js';
import type { RAGStore, RAGSearchResult, RAGSearchResultWithId } from './rag.js';
import type { BernardConfig } from './config.js';
import { resolveSiteModel } from './model-policy.js';
import { getCachedLLM, setCachedLLM, type LLMCacheKey } from './llm-cache.js';
import { usageRecordFromSite, type UsageRecorder } from './framework/hooks/token-stats.js';
import { buildRecentTurnsBlock, oneLine } from './reference-resolver.js';
import { buildRAGQuery, extractRecentUserTexts, extractRecentToolContext } from './rag-query.js';
import { getDomain } from './domains.js';

/**
 * RAG Recall Filter — a pre-turn LLM pass that decides which recalled memories
 * actually belong in the main agent's context this turn.
 *
 * Embedding cosine similarity measures *topical* similarity, not *relevance to
 * the current ask*, so the raw retrieval gate lets borderline facts through as
 * noise (context distraction). This pass casts a deliberately WIDE net
 * (loosened threshold, higher per-domain/total caps) via
 * {@link RAGStore.searchWithIds}, then asks a cheap-tier model to keep only the
 * facts relevant to the conversation. Strict selection only — it never rewrites
 * or synthesizes fact text, so provenance `rawRef`s and `[^Sn]` citations stay
 * intact downstream.
 *
 * Fail-open contract: every skip / empty / error path returns `{status:'noop'}`.
 * The caller (the REPL pre-turn pipeline) then injects nothing, and the agent
 * runs its normal narrow `ragStore.search()` — i.e. exactly today's behavior.
 * Only a successful `filtered` result overrides retrieval.
 */

export type RecallFilterResult =
  | { status: 'noop' }
  | { status: 'filtered'; facts: RAGSearchResult[] };

/** Deterministic classification — small JSON list of ids. */
const RECALL_FILTER_MAX_TOKENS = 512;

/**
 * Widened candidate-retrieval knobs (moderate). Deliberately looser than the
 * store defaults (0.35 / 5 / 15) so the LLM has more to choose from; it then
 * prunes back down. Module constants for v1, matching the other hardcoded RAG
 * tuning constants.
 */
const CANDIDATE_THRESHOLD = 0.28;
const CANDIDATE_TOP_K_PER_DOMAIN = 8;
const CANDIDATE_MAX = 24;

/** Cap the fact preview fed to the model so long facts can't blow the budget. */
const MAX_FACT_CHARS = 240;

const RECALL_FILTER_SYSTEM_PROMPT = `You are a memory relevance filter for an AI assistant.

You are given the user's current request, recent conversation, and a numbered list of candidate facts recalled from long-term memory by similarity search. Similarity search is noisy: some candidates are genuinely useful for answering THIS request, others are merely topically adjacent and would only distract the assistant.

Your job: select the subset of candidate facts that are relevant to the current request and conversation. Keep a fact only if it would plausibly help the assistant respond well right now. Drop facts that are off-topic, redundant, or only loosely related.

Rules:
- Judge relevance to the CURRENT request in the context of the recent conversation, not general interestingness.
- When a fact is clearly useful, keep it. When it is clearly irrelevant, drop it. When genuinely unsure, lean toward keeping it (a borderline-useful fact is cheaper than a lost one).
- Do NOT rewrite, merge, summarize, or invent facts. Only select from the numbered candidates by their number.
- It is valid to keep all of them, or to keep none.

Output strict JSON and nothing else:
  {"keep": [<numbers>]}
where <numbers> are the ids of the candidate facts to keep (e.g. {"keep":[1,3,4]}). Use {"keep":[]} to drop everything.`;

/** Renders the numbered candidate list the model selects from. */
function buildCandidateBlock(candidates: RAGSearchResultWithId[]): string {
  return [
    '## Candidate facts',
    ...candidates.map(
      (c, i) => `${i + 1}. [${getDomain(c.domain).name}] ${oneLine(c.fact, MAX_FACT_CHARS)}`,
    ),
  ].join('\n');
}

/** Parses `{"keep":[...]}` into a set of 1-based indices, or null on malformed input. */
function parseKeepResponse(text: string, candidateCount: number): Set<number> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed || !Array.isArray(parsed.keep)) return null;
    const keep = new Set<number>();
    for (const n of parsed.keep) {
      if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= candidateCount) {
        keep.add(n);
      }
    }
    return keep;
  } catch {
    return null;
  }
}

/**
 * Run the recall filter for one turn.
 *
 * @param agentInput  The (post-rewrite) user text the agent will process.
 * @param config      Resolved runtime config.
 * @param ragStore    The RAG store (candidate source + access recorder).
 * @param history     Conversation history WITHOUT the current turn's message
 *                    (matches the agent's own `this.history.slice(0,-1)`).
 * @returns `{status:'filtered', facts}` with the kept subset, or `{status:'noop'}`
 *          on any skip/empty/error so the caller falls back to normal retrieval.
 */
export async function recallFilter(
  agentInput: string,
  config: BernardConfig,
  ragStore: RAGStore,
  history: CoreMessage[],
  abortSignal?: AbortSignal,
  onUsage?: UsageRecorder,
): Promise<RecallFilterResult> {
  // Build the same context-enriched query the agent uses, so the candidate set
  // matches what retrieval would surface (just wider).
  const recentTexts = extractRecentUserTexts(history, 2);
  const toolContext = extractRecentToolContext(history);
  const query = buildRAGQuery(agentInput, recentTexts, { toolContext: toolContext || undefined });

  let candidates: RAGSearchResultWithId[];
  try {
    candidates = await ragStore.searchWithIds(query, {
      threshold: CANDIDATE_THRESHOLD,
      topKPerDomain: CANDIDATE_TOP_K_PER_DOMAIN,
      maxResults: CANDIDATE_MAX,
    });
  } catch (err) {
    debugLog('recall-filter:error', err instanceof Error ? err.message : String(err));
    return { status: 'noop' };
  }

  // Nothing to filter → let the agent's normal (narrow) search run.
  if (candidates.length === 0) {
    debugLog('recall-filter:noop', { reason: 'no-candidates' });
    return { status: 'noop' };
  }

  const historyBlock = buildRecentTurnsBlock(history);
  const userMessage = [
    `## User request\n${agentInput}`,
    historyBlock,
    buildCandidateBlock(candidates),
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');

  debugLog('recall-filter:request', { candidates: candidates.length });

  try {
    const site = resolveSiteModel(config, 'recall-filter');

    // LLM subcall cache (#171): temperature 0, so identical (model, system, user
    // content) reuse the prior result. Candidates shift per turn, so hits are
    // rare — included for consistency with the other pre-turn passes.
    const cacheOn = config.cacheEnabled !== false;
    const cacheKey: LLMCacheKey | null = cacheOn
      ? {
          siteName: 'recall-filter',
          modelId: site.model.modelId,
          providerOptions: site.providerOptions,
          params: site.params,
          system: RECALL_FILTER_SYSTEM_PROMPT,
          userContent: userMessage,
        }
      : null;

    let rawText: string;
    const cached = cacheKey ? getCachedLLM(cacheKey) : undefined;
    if (cached !== undefined) {
      if (abortSignal?.aborted) return { status: 'noop' };
      debugLog('cache:llm:hit', { site: 'recall-filter' });
      rawText = cached;
    } else {
      if (cacheKey) debugLog('cache:llm:miss', { site: 'recall-filter' });
      const result = await traceLlm('recall-filter', site.model.modelId, () =>
        generateText({
          model: site.model,
          providerOptions: site.providerOptions,
          // Slot params (temperature/topP) apply, but spread BEFORE maxTokens so
          // this site's output cap stays authoritative (#286).
          ...site.params,
          system: RECALL_FILTER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
          maxSteps: 1,
          maxTokens: RECALL_FILTER_MAX_TOKENS,
          abortSignal,
        }),
      );
      onUsage?.(usageRecordFromSite(site, 'recall-filter', result.usage, result.providerMetadata));
      if (!result.text) {
        debugLog('recall-filter:noop', { reason: 'empty-response' });
        return { status: 'noop' };
      }
      rawText = result.text;
      if (cacheKey) setCachedLLM(cacheKey, rawText);
    }

    const keep = parseKeepResponse(rawText, candidates.length);
    if (!keep) {
      debugLog('recall-filter:noop', { reason: 'parse-failed', raw: rawText.slice(0, 200) });
      return { status: 'noop' };
    }

    // If the user aborted while the model was responding, don't commit any
    // side effects: this turn's context is discarded by the caller, so bumping
    // TTL for facts that were never injected would skew the access heuristics.
    if (abortSignal?.aborted) return { status: 'noop' };

    const kept = candidates.filter((_, i) => keep.has(i + 1));
    debugLog('recall-filter:kept', { candidates: candidates.length, kept: kept.length });

    // Commit access for exactly the facts we keep, so TTL extension tracks
    // genuinely-relevant memories rather than every topical match.
    ragStore.recordAccess(kept.map((c) => c.id));

    const facts: RAGSearchResult[] = kept.map(({ fact, similarity, domain }) => ({
      fact,
      similarity,
      domain,
    }));
    return { status: 'filtered', facts };
  } catch (err) {
    debugLog('recall-filter:error', err instanceof Error ? err.message : String(err));
    return { status: 'noop' };
  }
}
