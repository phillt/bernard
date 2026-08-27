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
import { REWRITER_HINTS_KEY, type MemoryStore } from './memory.js';
import { MAX_PERSISTENT_MEMORY_CHARS } from './context-message.js';
import { plural } from './text.js';

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
  | {
      status: 'filtered';
      facts: RAGSearchResult[];
      /**
       * How user-curated memory bears on the facts above — e.g. that a memory
       * supersedes one clause of an otherwise-still-correct recalled fact
       * (#371). Rendered beside the facts, never merged into them. `undefined`
       * when there is nothing to reconcile.
       */
      reconciliation?: string;
      /**
       * Memory keys ordered most- to least-relevant to this turn. Used ONLY to
       * decide packing order when memory exceeds its char budget; under budget
       * every entry is injected regardless, so this changes nothing. Replaces
       * a drop-by-filename outcome with a drop-by-relevance one.
       */
      memoryPriority?: string[];
    };

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

You may also be given "## Curated memory" — notes the user explicitly asked the assistant to remember. These are authoritative in a way candidate facts are not: candidates were auto-extracted from past sessions by similarity, memory was written down on purpose.

Second job — reconcile. If a memory contradicts or narrows something a KEPT candidate says, write one short "reconciliation" sentence telling the assistant how to read them together. Be precise about scope: recalled facts are usually mostly still correct with one stale clause, so say which part the memory overrides and that the rest still applies. Do not restate a memory that no kept candidate touches. Set it to null when there is no conflict — that is the common case.

Output strict JSON and nothing else:
  {"keep": [<numbers>], "reconciliation": <string or null>}
e.g. {"keep":[1,3],"reconciliation":"The memory \`daily-blaze-no-time\` overrides the \"Time ~X hrs\" line in the kept template fact; the rest of that template still applies."}
Use {"keep":[]} to drop every candidate. Omit or null "reconciliation" when nothing conflicts.`;

/**
 * Appended ONLY when curated memory exceeds its injection budget, i.e. when
 * something will actually be dropped.
 *
 * Asking unconditionally made the model echo every memory key verbatim on every
 * turn — ~250 serial output tokens on a pass that blocks the user's turn, for a
 * ranking that is discarded whenever memory fits (the common case). Worse, the
 * echo shares `RECALL_FILTER_MAX_TOKENS` with `keep`: enough entries and the
 * JSON truncates mid-array, `parseCuratorResponse` fails, and the **selection**
 * is lost with it. The cost scaled with memory size — i.e. against precisely
 * the users the ranking exists to help.
 */
const MEMORY_RANKING_PROMPT = `

Extra job for this request — curated memory is too large to fit in full, so some of it will be dropped. Return "memoryPriority": every memory key, ordered most- to least-relevant to this request, and include all of them.
IMPORTANT: a standing rule ("never email the client directly", "always run tests before pushing") is relevant even when it is off-topic for this request — rank those high. Rank low only entries that are situational and clearly do not apply.
Output shape becomes: {"keep": [<numbers>], "reconciliation": <string or null>, "memoryPriority": [<keys>]}`;

/** Renders the numbered candidate list the model selects from. */
function buildCandidateBlock(candidates: RAGSearchResultWithId[]): string {
  return [
    '## Candidate facts',
    ...candidates.map(
      (c, i) => `${i + 1}. [${getDomain(c.domain).name}] ${oneLine(c.fact, MAX_FACT_CHARS)}`,
    ),
  ].join('\n');
}

/**
 * Per-entry preview cap in the curator prompt. Deliberately larger than
 * `reference-resolver`'s 140: that pass only has to recognise which entry names
 * an entity; this one has to spot a clause inside an entry that contradicts a
 * recalled fact, which needs more of the text.
 */
const MAX_MEMORY_ENTRY_CHARS = 400;

/**
 * Whole-block cap. Without it the block is `MAX_MEMORY_ENTRY_CHARS × entries`
 * and unbounded — so a user over the persistent-memory budget would send the
 * cheap-tier curator *more* memory than the main agent it advises, since
 * `renderPersistentMemory` drops entries at that budget and this would not.
 * Same constant, so the curator never sees more than the agent.
 */
const MAX_MEMORY_BLOCK_CHARS = MAX_PERSISTENT_MEMORY_CHARS;

/**
 * Reads memory once for the whole pass. `getAllMemoryContents` is `readdirSync`
 * plus a `readFileSync` per entry with no cache, so callers must not re-derive
 * keys from a second call.
 *
 * Excludes `rewriter-hints`: it is internal infra written by the resolver, and
 * presenting it to the curator as "written down on purpose" would let it
 * compete for the memory budget as though the user had authored it.
 * `reference-resolver` drops it before its own prompt for the same reason.
 */
function readCuratedMemory(memoryStore?: MemoryStore): Map<string, string> {
  if (!memoryStore) return new Map();
  try {
    const entries = memoryStore.getAllMemoryContents();
    entries.delete(REWRITER_HINTS_KEY);
    return entries;
  } catch {
    return new Map();
  }
}

/** Renders the curated-memory block the model reconciles against. `''` when empty. */
function buildMemoryBlock(entries: Map<string, string>): string {
  if (entries.size === 0) return '';
  const lines = ['## Curated memory (authoritative — written down on purpose)'];
  let used = 0;
  let omitted = 0;
  for (const [key, content] of entries) {
    const line = `- \`${key}\`: ${oneLine(content, MAX_MEMORY_ENTRY_CHARS)}`;
    if (used + line.length > MAX_MEMORY_BLOCK_CHARS) {
      omitted++;
      continue;
    }
    lines.push(line);
    used += line.length;
  }
  if (omitted > 0) lines.push(`- … ${omitted} more ${plural(omitted, 'entry', 'entries')} omitted`);
  return lines.join('\n');
}

/** Total chars of curated memory — decides whether a ranking is worth asking for. */
function memoryChars(entries: Map<string, string>): number {
  let n = 0;
  for (const [key, content] of entries) n += key.length + content.length;
  return n;
}

interface CuratorResponse {
  keep: Set<number>;
  reconciliation?: string;
  memoryPriority?: string[];
}

/**
 * Parses the curator's JSON. Returns null only when `keep` is unusable — a
 * malformed `reconciliation` or `memoryPriority` degrades to `undefined`
 * rather than discarding a good selection, since selection is the job the
 * pipeline cannot fall back from cheaply.
 */
function parseCuratorResponse(
  text: string,
  candidateCount: number,
  knownMemoryKeys: Set<string>,
): CuratorResponse | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.keep)) return null;

  const keep = new Set<number>();
  for (const n of parsed.keep) {
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= candidateCount) {
      keep.add(n);
    }
  }

  const rawNote = parsed.reconciliation;
  const reconciliation =
    typeof rawNote === 'string' && rawNote.trim().length > 0 ? rawNote.trim() : undefined;

  // Keys are echoed back by the model, so filter to ones that actually exist —
  // a hallucinated key would otherwise reorder real entries around a ghost.
  let memoryPriority: string[] | undefined;
  if (Array.isArray(parsed.memoryPriority)) {
    // A Set both dedupes and preserves insertion order.
    const ordered = [
      ...new Set(
        parsed.memoryPriority.filter(
          (k): k is string => typeof k === 'string' && knownMemoryKeys.has(k),
        ),
      ),
    ];
    if (ordered.length > 0) memoryPriority = ordered;
  }

  return { keep, reconciliation, memoryPriority };
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
  opts: {
    /**
     * Curated memory, passed as READ-ONLY context so the curator can reconcile
     * it against the candidates and — only when memory is over budget — rank it
     * for trimming.
     *
     * The distinction from #307 Phase 3 is narrower than "memory is never
     * eliminated", which is false in the one regime the ranking fires. Under
     * budget nothing is dropped and the ranking is unused; over budget
     * `renderPersistentMemory` drops the tail either way, and the tail is now
     * chosen by relevance rather than by filename. So the curator never causes
     * a drop — it only decides which drop — where Phase 3 would have had it
     * filtering memory on every turn, including turns where nothing was over
     * budget at all.
     *
     * The residual risk is real and is why {@link MEMORY_RANKING_PROMPT}
     * explicitly protects standing rules: a topical ranker puts "never email
     * the client directly" last by construction, and that is exactly the entry
     * that must not be dropped.
     */
    memoryStore?: MemoryStore;
    abortSignal?: AbortSignal;
    onUsage?: UsageRecorder;
  } = {},
): Promise<RecallFilterResult> {
  const { memoryStore, abortSignal, onUsage } = opts;
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
  const memoryEntries = readCuratedMemory(memoryStore);
  const memoryBlock = buildMemoryBlock(memoryEntries);
  // Only worth a ranking when something will actually be dropped.
  const needsRanking = memoryChars(memoryEntries) > MAX_PERSISTENT_MEMORY_CHARS;
  const systemPrompt = needsRanking
    ? RECALL_FILTER_SYSTEM_PROMPT + MEMORY_RANKING_PROMPT
    : RECALL_FILTER_SYSTEM_PROMPT;
  const userMessage = [
    `## User request\n${agentInput}`,
    historyBlock,
    memoryBlock,
    buildCandidateBlock(candidates),
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');

  debugLog('recall-filter:request', {
    candidates: candidates.length,
    memoryEntries: memoryEntries.size,
    needsRanking,
  });

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
          system: systemPrompt,
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
      const t0 = Date.now();
      const result = await traceLlm('recall-filter', site.model.modelId, () =>
        generateText({
          model: site.model,
          providerOptions: site.providerOptions,
          // Slot params (temperature/topP) apply, but spread BEFORE maxTokens so
          // this site's output cap stays authoritative (#286).
          ...site.params,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
          maxSteps: 1,
          maxTokens: RECALL_FILTER_MAX_TOKENS,
          abortSignal,
        }),
      );
      onUsage?.(
        usageRecordFromSite(site, 'recall-filter', result.usage, result.providerMetadata, {
          latencyMs: Date.now() - t0,
        }),
      );
      if (!result.text) {
        debugLog('recall-filter:noop', { reason: 'empty-response' });
        return { status: 'noop' };
      }
      rawText = result.text;
      if (cacheKey) setCachedLLM(cacheKey, rawText);
    }

    const parsed = parseCuratorResponse(rawText, candidates.length, new Set(memoryEntries.keys()));
    if (!parsed) {
      debugLog('recall-filter:noop', { reason: 'parse-failed', raw: rawText.slice(0, 200) });
      return { status: 'noop' };
    }
    const { keep, reconciliation, memoryPriority } = parsed;

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
    if (reconciliation) debugLog('recall-filter:reconciliation', { note: reconciliation });
    return { status: 'filtered', facts, reconciliation, memoryPriority };
  } catch (err) {
    debugLog('recall-filter:error', err instanceof Error ? err.message : String(err));
    return { status: 'noop' };
  }
}
