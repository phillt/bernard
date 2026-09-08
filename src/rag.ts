import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getEmbeddingProvider,
  cosineSimilarity,
  EMBEDDING_MODEL_ID,
  type EmbeddingProvider,
} from './embeddings.js';
import { LexicalIndex, namesASymbol, reciprocalRankFusion } from './lexical.js';
import { debugLog } from './logger.js';
import { DEFAULT_DOMAIN } from './domains.js';
import { RAG_DIR, MEMORIES_FILE, LAST_SESSION_FILE } from './paths.js';
import { atomicWriteFileSyncUnique } from './fs-utils.js';

/** Maximum results returned per domain before merging. */
export const DEFAULT_TOP_K_PER_DOMAIN = 5;
/** Maximum total results returned from a search. */
export const DEFAULT_MAX_RESULTS = 15;
/** Minimum cosine similarity for a memory to be considered relevant. */
const DEFAULT_SIMILARITY_THRESHOLD = 0.35;
/** Hard cap on stored memories; excess is pruned by score. */
const DEFAULT_MAX_MEMORIES = 5000;
/** Cosine similarity above which a new fact is considered a duplicate. */
const DEDUP_THRESHOLD = 0.92;
/** Half-life in days for the recency decay used in capacity-based pruning. */
const PRUNE_HALF_LIFE_DAYS = 90;
/** Maximum age of `.pending-*.json` temp files before cleanup (1 hour). */
const STALE_TEMP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
/** Default time-to-live in days for newly created memories. */
const DEFAULT_RAG_TTL_DAYS = 90;

/**
 * How long pending access bookkeeping may sit unwritten (#533).
 *
 * A backstop, not the mechanism: every exit path flushes explicitly, so this
 * only covers a process that is killed rather than closed. Long enough that a
 * burst of dispatches coalesces into one write, short enough that a SIGKILL
 * loses at most a few seconds of decay metadata — which costs one TTL
 * extension, not a fact.
 */
const FLUSH_DEBOUNCE_MS = 5_000;

/**
 * Bumped only when the on-disk SHAPE changes, never when the model does — a
 * model change is `model`/`dimensions`, and it is a refusal rather than a
 * discard. Version 1 is the first stamped store; a bare array is version 0 by
 * absence.
 */
const STORE_SCHEMA_VERSION = 1;

/**
 * Dimensionality written into the stamp.
 *
 * Read off the provider where one is available and from this constant on the
 * write path, where `persist` is synchronous and `getEmbeddingProvider` is not.
 * They cannot disagree: both describe the one hardcoded model, and the moment
 * that stops being true is the moment the swap decision (#520's other half)
 * gets made.
 */
const EMBEDDING_DIMENSIONS = 384;

/** The stamped on-disk shape (#520). A bare `RAGMemory[]` is the legacy form. */
export interface StoredMemories {
  version: number;
  model: string;
  dimensions: number;
  memories: RAGMemory[];
}

/** A single stored memory with its embedding vector and lifecycle metadata. */
export interface RAGMemory {
  /** Unique identifier (timestamp + random suffix). */
  id: string;
  /** The plain-text fact extracted from conversation. */
  fact: string;
  /** Pre-computed embedding vector for similarity search. */
  embedding: number[];
  /** Origin of the fact, e.g. "compression" or "user". */
  source: string;
  /** Domain category this fact belongs to (e.g. "general", "tool-usage"). */
  domain: string;
  /** ISO 8601 timestamp when the memory was created. */
  createdAt: string;
  /** Number of times this memory has been returned in search results. */
  accessCount: number;
  /** ISO 8601 timestamp of the most recent search hit. */
  lastAccessed?: string;
  /**
   * How many times this fact has been LEARNED AGAIN — i.e. re-extracted and
   * met the dedup threshold against this record (#525).
   *
   * **A separate counter from {@link accessCount}, deliberately.** They measure
   * different things: `accessCount` is "was retrieved", which says a fact is
   * topically adjacent to what people ask about; this is "was observed again",
   * which is the strongest available evidence that a fact is *durable*. #372
   * makes the same distinction, and is about to cap and decay `accessCount`
   * specifically to break an entrenchment loop that retrieval creates — folding
   * observations into it would cap and decay them for a reason that has nothing
   * to do with them.
   *
   * Absent on every record written before this, and read as 0.
   */
  observedCount?: number;
  /** ISO 8601 timestamp after which the memory is eligible for expiration pruning. */
  expiresAt?: string;
}

/** A search result containing the matched fact, its similarity score, and domain. */
export interface RAGSearchResult {
  fact: string;
  similarity: number;
  domain: string;
}

/** Extended search result that includes the memory ID and lifecycle metadata. */
export interface RAGSearchResultWithId {
  id: string;
  fact: string;
  similarity: number;
  domain: string;
  createdAt: string;
  accessCount: number;
}

/**
 * Per-call ranking overrides for {@link RAGStore.searchWithIds}. Lets a caller
 * widen the retrieval net beyond the store's configured defaults (e.g. the
 * recall-filter pass casts a wide net, then an LLM prunes it). Any omitted
 * field falls back to the store's instance-level setting.
 */
export interface RAGSearchOverrides {
  /** Minimum cosine similarity to include a candidate. */
  threshold?: number;
  /** Max candidates per domain before merging. */
  topKPerDomain?: number;
  /** Max total candidates after merge. */
  maxResults?: number;
}

/** Optional configuration overrides for {@link RAGStore}. All fields fall back to sensible defaults. */
export interface RAGStoreConfig {
  /** Max results per domain before merging (default: 5). */
  topKPerDomain?: number;
  /** Max total results from a search (default: 15). */
  maxResults?: number;
  /** Minimum cosine similarity to include a result (default: 0.35). */
  similarityThreshold?: number;
  /** Hard cap on stored memories (default: 5000). */
  maxMemories?: number;
  /** Time-to-live in days for new memories (default: 90). */
  ragTtlDays?: number;
}

/**
 * Push a memory's `expiresAt` out to `nowMs + days`, but only ever forward.
 *
 * **Monotone is the whole contract.** Both writers compute a different curve —
 * {@link RAGStore.bumpAccess} off `accessCount`, {@link RAGStore.reinforce} off
 * `observedCount` — and the two interleave in any order, so a record that was
 * re-learned (a long extension) and then merely retrieved (a short one) must
 * not have its expiry pulled back in. Written once here rather than at each
 * writer because a guard that is right in one copy and dropped in the other
 * fails silently: the record simply expires early, months later, with nothing
 * to trace it to.
 *
 * Mutates in place; the caller persists.
 */
function extendExpiry(memory: RAGMemory, days: number, nowMs: number): void {
  const next = nowMs + days * 86400000;
  if (!memory.expiresAt || next > new Date(memory.expiresAt).getTime()) {
    memory.expiresAt = new Date(next).toISOString();
  }
}

/**
 * Disk-backed vector store for long-term conversational memory.
 * Stores facts as embeddings, supports similarity search with per-domain top-k ranking,
 * and manages memory lifecycle via TTL-based expiration and capacity pruning.
 */
export class RAGStore {
  private memories: RAGMemory[] = [];
  private topKPerDomain: number;
  private maxResults: number;
  private similarityThreshold: number;
  private maxMemories: number;
  private ragTtlDays: number;
  /**
   * Per-turn search cache (#171). Maps the verbatim query string to the
   * computed `RAGSearchResult[]`. Cleared at the REPL turn boundary via
   * {@link clearTurnCache} so cross-turn updates to memory are visible. On a
   * hit, access-metadata bumping is skipped — the first call in the turn
   * already updated it.
   */
  private turnSearchCache = new Map<string, RAGSearchResult[]>();
  /**
   * Per-turn query-embedding cache. Maps the verbatim query string to its
   * computed vector, so a query embedded once in a turn (e.g. the recall
   * filter's widened `searchWithIds`) isn't re-embedded when the agent later
   * falls back to `search()` with the same query. Shares the turn boundary with
   * {@link turnSearchCache} (cleared together).
   */
  private turnEmbeddingCache = new Map<string, number[]>();
  /**
   * Access bookkeeping written but not yet flushed (#533).
   *
   * `search()` used to call {@link persist} on every hit, and `persist` is a
   * `JSON.stringify` of the whole array plus a write. Measured on a real
   * 3,664-record / 31 MB store: **188 ms to serialize**, ~27 ms to write, all
   * synchronous on the main thread — so every search that returned anything
   * froze the event loop for roughly a fifth of a second, to record an
   * `accessCount++` and a timestamp. In the REPL that is Ink's render loop and
   * the streaming reply. Across this machine's session logs: 174 searches, 26
   * in the busiest single session — about 5.6 s of dead air in one
   * conversation, none of it correctness.
   *
   * **What is deferred is bookkeeping, and only bookkeeping.** Every field
   * {@link bumpAccess} touches is decay metadata: `accessCount`,
   * `lastAccessed` (which has no reader anywhere in the repo) and `expiresAt`.
   * Losing an unflushed bump costs at most one TTL extension. `addFacts`,
   * `clear` and `deleteByIds` write CONTENT and stay eager — a crash must not
   * lose a fact, only the note that a fact was useful.
   *
   * **Held in one object shared by reference, the way `memories` is.** A
   * scoped view (#511) is a shallow clone, so a per-field `dirty` flag would be
   * COPIED into the view: the view's search would mark the view dirty, the exit
   * hooks would call `flush()` on the root, whose flag is still false, and the
   * explicit half of the "both halves are required" contract below would
   * silently stop applying to every scoped dispatch. A copied `flushTimer` is
   * worse — a view's `markDirty` would see the root's live handle, early-return,
   * and never schedule its own.
   *
   * The timer is `unref`ed, following `inbox/watcher.ts`, so a pending flush can
   * never be the reason a process will not exit — which also means the timer
   * alone is not a guarantee, and every exit path must call {@link flush}
   * explicitly. Both halves are required; neither is sufficient.
   */
  private persistState: { dirty: boolean; timer: NodeJS.Timeout | null } = {
    dirty: false,
    timer: null,
  };
  /**
   * Domains this instance may retrieve from, or `null` for the unscoped store
   * (#511).
   *
   * The `domain` axis has existed, been populated and been ranked on since day
   * one — `scoreAndRank` already GROUPS by it — and has never once been
   * filtered on. This is the first reader. On a real store: `general` 1,217,
   * `conversations` 935, `tool-usage` 1,131, `user-preferences` 381.
   */
  private domainScope: readonly string[] | null = null;
  /**
   * What the on-disk store says wrote it, when it says anything (#520).
   * Absent for a legacy bare-array store, which is adopted rather than refused.
   */
  private stamp: { model?: string; dimensions?: number } | null = null;
  /** A legacy store was read; write the stamp back on the next persist. */
  private needsStamp = false;
  /** See {@link retrievalDisabledReason}. Non-null IS the once-per-process latch. */
  private disabledReason: string | null = null;
  /**
   * The BM25 index, built lazily and keyed on the corpus it describes (#526).
   *
   * Cached on the corpus ARRAY identity rather than on a dirty flag: a scoped
   * view (#511) filters `memories` into a different array on every call, and a
   * flag on the store would hand a scoped search the unscoped index — silently,
   * since BM25 would still return plausible-looking scores for the wrong
   * population. Identity is the one key that cannot get that wrong.
   *
   * Rebuilt rather than maintained, and the honest cost is **~77 ms at 3,662
   * records** — 45× the 1.7 ms cosine scan, not "a rounding error" as an
   * earlier version of this comment claimed. It is affordable because it is
   * paid ONCE per store (see the cache key) and only when a query actually
   * names a symbol, so an ordinary prose turn never builds it at all. An
   * incrementally-maintained index would avoid that first hit and become a
   * second source of truth that can drift from the array it describes.
   */
  private lexicalCache: {
    memories: readonly RAGMemory[];
    scope: readonly string[] | null;
    index: LexicalIndex;
  } | null = null;

  constructor(config?: RAGStoreConfig) {
    this.topKPerDomain = config?.topKPerDomain ?? DEFAULT_TOP_K_PER_DOMAIN;
    this.maxResults = config?.maxResults ?? DEFAULT_MAX_RESULTS;
    this.similarityThreshold = config?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.maxMemories = config?.maxMemories ?? DEFAULT_MAX_MEMORIES;
    this.ragTtlDays = config?.ragTtlDays ?? DEFAULT_RAG_TTL_DAYS;

    fs.mkdirSync(RAG_DIR, { recursive: true });
    this.load();
    this.saveSessionDate();
    this.pruneExpired();
    RAGStore.cleanupStaleTemp();
  }

  /**
   * A narrowed view of this store, restricted to the given domains (#511).
   *
   * Shares `memories` and the query-EMBEDDING cache by reference — it must:
   * `search` mutates access metadata and the embedding is where the real cost
   * is. It deliberately does **not** share {@link turnSearchCache}.
   *
   * **That omission is a fail-open hazard closed, not an optimisation skipped.**
   * `turnSearchCache` is keyed on the verbatim query string ALONE. So `main`
   * searching "deployment process" unscoped and caching fifteen results, then a
   * scoped child searching the same string, would hand the child the *unscoped*
   * results straight out of the cache — with no code path ever consulting a
   * domain. A composite key would work and is a correctness question nobody
   * re-checks; a view has no cache at all, is per-dispatch, and is discarded,
   * so there is nothing to invalidate.
   */
  scoped(domains: readonly string[] | null | undefined): RAGStore {
    if (!domains) return this;
    const base = this.domainScope;
    const next = base === null ? [...domains] : domains.filter((d) => base.includes(d));
    const view = Object.create(RAGStore.prototype) as RAGStore;
    // `persistState` rides along in the spread, by reference — which is the
    // point: a view's access bookkeeping must reach the root's `flush()`.
    Object.assign(view, this, { domainScope: next, turnSearchCache: new Map() });
    return view;
  }

  /** Delete .pending-*.json temp files older than 1 hour (handles crashed workers). */
  static cleanupStaleTemp(): void {
    try {
      const entries = fs.readdirSync(RAG_DIR);
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.startsWith('.pending-') || !entry.endsWith('.json')) continue;
        const filePath = path.join(RAG_DIR, entry);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > STALE_TEMP_MAX_AGE_MS) {
            fs.unlinkSync(filePath);
            debugLog('rag:cleanupStaleTemp', `Deleted stale temp file: ${entry}`);
          }
        } catch {
          // Ignore per-file errors
        }
      }
    } catch {
      // Ignore — directory may not exist yet
    }
  }

  /**
   * Embed and store new facts. Deduplicates against existing memories.
   * Returns the number of facts actually added.
   */
  async addFacts(
    facts: string[],
    source: string,
    domain: string = DEFAULT_DOMAIN,
  ): Promise<number> {
    if (facts.length === 0) return 0;

    const provider = await getEmbeddingProvider();
    if (!provider) {
      debugLog('rag:addFacts', 'No embedding provider available, skipping');
      return 0;
    }

    let embeddings: number[][];
    try {
      embeddings = (await provider.embed(facts)).map((e) => Array.from(e));
    } catch (err) {
      debugLog(
        'rag:addFacts',
        `Embedding failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }

    let added = 0;
    let reinforced = 0;
    const now = new Date().toISOString();
    const nowMs = Date.now();

    for (let i = 0; i < facts.length; i++) {
      const fact = facts[i];
      const embedding = embeddings[i];

      // Deduplicate — but reinforce the survivor rather than discarding the
      // observation (#525). `find`, not `some`. The survivor has to be in scope to be
      // reinforced, and `some` deliberately discards it — which is the whole
      // shape of the defect: the newcomer was dropped and the record it
      // collided with gained nothing, so re-learning a fact across ten sessions
      // was indistinguishable from learning it once.
      //
      // Note the scan is over the whole unscoped array and crosses domains, so
      // a fact can collide with a survivor filed under a different domain.
      // That was always true; reinforcing makes it visible where discarding
      // hid it, and `rag:dedup` now names both domains for exactly that reason.
      const survivor = this.memories.find(
        (m) => cosineSimilarity(m.embedding, embedding) > DEDUP_THRESHOLD,
      );
      if (survivor) {
        this.reinforce(survivor, source, now, nowMs);
        debugLog('rag:dedup', {
          fact: fact.slice(0, 80),
          survivor: survivor.id,
          observedCount: survivor.observedCount,
          sameDomain: survivor.domain === domain,
        });
        reinforced++;
        continue;
      }

      this.memories.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        fact,
        embedding,
        source,
        domain,
        createdAt: now,
        accessCount: 0,
        expiresAt: new Date(Date.now() + this.ragTtlDays * 86400000).toISOString(),
      });
      added++;
    }

    if (added > 0) {
      this.prune();
      this.persist();
      // New facts could change search results — invalidate the per-turn caches
      // so subsequent same-turn lookups pick them up (#171).
      this.clearTurnCache();
    } else if (reinforced > 0) {
      // Reinforcement changes decay metadata, not content — so it takes the
      // DEBOUNCED path (#533) rather than the eager one `added` uses. A crash
      // must not lose a fact; losing the note that a fact was observed again
      // costs one TTL extension. The turn caches are untouched deliberately:
      // no fact was added or removed, so no search result can have changed.
      this.markDirty();
    }

    debugLog('rag:addFacts', { added, reinforced, total: this.memories.length, domain });
    return added;
  }

  /**
   * Score, group by domain (top-k per domain), and cap at maxResults.
   * Shared by search() and searchWithIds().
   */
  /**
   * The one place the corpus is consumed and a ranked list is produced — and
   * since #526, the one place the two retrieval channels fuse.
   *
   * It takes the raw `query` as well as its embedding, which it did not need
   * before: BM25 works on terms, not vectors. Threading the string down here
   * rather than fusing in the two callers is what keeps `search` and
   * `searchWithIds` from drifting into two different rankings.
   */
  private scoreAndRank(
    query: string,
    queryEmbedding: number[],
    overrides?: RAGSearchOverrides,
  ): { memory: RAGMemory; similarity: number }[] {
    const threshold = overrides?.threshold ?? this.similarityThreshold;
    const topKPerDomain = overrides?.topKPerDomain ?? this.topKPerDomain;
    const maxResults = overrides?.maxResults ?? this.maxResults;

    // The filter goes in FRONT of the per-domain grouping below, so a scoped
    // search is the same ranking over a smaller corpus rather than a truncation
    // of a wider result (#511).
    const corpus =
      this.domainScope === null
        ? this.memories
        : this.memories.filter((m) => this.domainScope!.includes(m.domain));

    const dense = corpus
      .map((m, i) => ({
        memory: m,
        similarity: cosineSimilarity(queryEmbedding, m.embedding),
        corpusIndex: i,
      }))
      .filter((s) => s.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity);

    // **The lexical channel, fused by rank (#526).** BM25 runs over the same
    // scoped corpus, and the two rankings are combined with RRF.
    //
    // Rank-based fusion, not score-based: cosine is bounded in [-1,1] while
    // BM25 is unbounded and corpus-dependent, so blending the scores requires
    // choosing a normalisation that is itself an untuned parameter. Ranks need
    // none.
    //
    // **The lexical channel is not subject to `threshold`.** That number is
    // calibrated on cosine and means nothing on a BM25 score; applying it would
    // silently drop every lexical-only hit — which is the entire population
    // this channel exists to recover, since a record whose term sits past the
    // embedder's 256-word-piece ceiling has a *low* cosine by construction.
    // **Gated on whether the query names a SYMBOL.** Ungated, this fusion
    // recovered both identifier misses and destroyed paraphrase ranking (MRR
    // 0.75 → 0.22 on the eval corpus). An earlier frequency-based gate looked
    // like it fixed that and did not survive contact with a real store — see
    // `namesASymbol`, which carries the measurement and why the separating
    // property is the query's shape rather than the corpus's statistics.
    //
    // Checked BEFORE the index is built, so a prose query pays nothing: the
    // build is ~77 ms at 3,662 records against a ~1.7 ms cosine scan.
    const lexical = namesASymbol(query)
      ? [...this.lexicalIndex(corpus).score(query).entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([i]) => i)
      : [];

    const denseRanking = dense.map((d) => d.corpusIndex);
    const order = lexical.length > 0 ? reciprocalRankFusion([denseRanking, lexical]) : denseRanking;

    // **Cosine is resolved for the SURVIVORS only.** Computing it for every
    // fused candidate here meant ~2,400 redundant cosine computations per
    // search on a real store — 3,114 fused entries reduced to 15 by the caps
    // below. It is output-identical to defer it, because nothing between here
    // and the return orders by `similarity`: the domain grouping and the final
    // sort both key on fused position.
    const byIndex = new Map(dense.map((d) => [d.corpusIndex, d]));
    const scored = order.map((i) => ({ memory: corpus[i], corpusIndex: i }));

    // One pass, in fused order, so the ordering is structural rather than
    // restored by a re-sort. `similarity` stays COSINE — it is the scale
    // `threshold` is calibrated on, the scale `applyStickiness` boosts and
    // clamps at 1.0, and the number `bernard facts` prints, so a fused score
    // there would decalibrate all three silently.
    const perDomain = new Map<string, number>();
    const merged: { memory: RAGMemory; similarity: number }[] = [];
    for (const e of scored) {
      const n = perDomain.get(e.memory.domain) ?? 0;
      if (n >= topKPerDomain) continue;
      perDomain.set(e.memory.domain, n + 1);
      merged.push({
        memory: e.memory,
        similarity:
          byIndex.get(e.corpusIndex)?.similarity ??
          cosineSimilarity(queryEmbedding, e.memory.embedding),
      });
      if (merged.length === maxResults) break;
    }
    return merged;
  }

  /**
   * Bump one memory's access metadata and extend its TTL by "base 7d +
   * log-scaled by access count, capped at half TTL". Shared by {@link search}
   * and {@link recordAccess}. Mutates `memory` in place; the caller is
   * responsible for persisting.
   *
   * The sibling is {@link reinforce}, which credits an OBSERVATION rather than
   * a retrieval and computes a different, longer extension. Only the monotone
   * guard is shared, in {@link extendExpiry} — the two curves are deliberately
   * distinct, which is what makes a re-learned fact outlive a merely
   * often-retrieved one.
   */
  private bumpAccess(memory: RAGMemory, now: string, nowMs: number): void {
    memory.accessCount++;
    memory.lastAccessed = now;
    extendExpiry(
      memory,
      Math.min(this.ragTtlDays * 0.5, 7 + Math.log2(memory.accessCount + 1) * 3),
      nowMs,
    );
  }

  /**
   * Record access for a specific set of memory ids, bumping access counts and
   * extending TTLs exactly as a {@link search} hit would. Used by the
   * recall-filter pass, which retrieves candidates read-only via
   * {@link searchWithIds} and then commits access for only the facts an LLM
   * deemed relevant — so TTL extension tracks genuinely-useful memories rather
   * than every topical match. No-op for unknown ids; persists if anything changed.
   */
  recordAccess(ids: string[]): void {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    const now = new Date().toISOString();
    const nowMs = Date.now();
    let touched = 0;
    for (const memory of this.memories) {
      if (wanted.has(memory.id)) {
        this.bumpAccess(memory, now, nowMs);
        touched++;
      }
    }
    if (touched > 0) {
      debugLog('rag:recordAccess', { requested: ids.length, touched });
      // Shares the debounce rather than growing a second mechanism (#533).
      // Once per turn is defensible on its own, but it writes the same fields
      // for the same reason and should not be the one path that still costs a
      // 31 MB rewrite.
      this.markDirty();
    }
  }

  /** Embed a query string, returning the embedding vector or null on failure. */
  private async embedQuery(query: string, logLabel: string): Promise<number[] | null> {
    const cacheOn = process.env.BERNARD_CACHE_ENABLED !== 'false';
    if (cacheOn) {
      const cached = this.turnEmbeddingCache.get(query);
      if (cached) return cached;
    }

    const provider = await getEmbeddingProvider();
    if (!provider) return null;

    // The one choke point both `search` and `searchWithIds` pass through, so
    // the refusal covers every read path without being written twice (#520).
    const mismatch = this.modelMismatch(provider);
    if (mismatch) {
      this.warnMismatchOnce(mismatch);
      return null;
    }

    try {
      const vector = Array.from((await provider.embed([query]))[0]);
      if (cacheOn) this.turnEmbeddingCache.set(query, vector);
      return vector;
    } catch (err) {
      debugLog(
        logLabel,
        `Query embedding failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Search for memories relevant to the query.
   * Per-domain top-k: takes up to topKPerDomain results per domain,
   * then merges and caps at maxResults total.
   */
  async search(query: string): Promise<RAGSearchResult[]> {
    if (this.memories.length === 0) return [];

    // Per-turn cache (#171). Avoids re-embedding the same query when both
    // the agent and the reference resolver run a RAG lookup in the same turn.
    // Disabled via BERNARD_CACHE_ENABLED=false; read directly here so RAGStore
    // doesn't need a config dependency.
    const cacheOn = process.env.BERNARD_CACHE_ENABLED !== 'false';
    if (cacheOn) {
      const cached = this.turnSearchCache.get(query);
      if (cached) {
        debugLog('cache:rag:hit', { query: query.slice(0, 80), returned: cached.length });
        return cached;
      }
    }

    const queryEmbedding = await this.embedQuery(query, 'rag:search');
    if (!queryEmbedding) return [];

    const capped = this.scoreAndRank(query, queryEmbedding);

    debugLog('rag:search', { query: query.slice(0, 100), returned: capped.length });

    // Update access metadata and extend expiration
    const now = new Date().toISOString();
    const nowMs = Date.now();
    for (const { memory } of capped) {
      this.bumpAccess(memory, now, nowMs);
    }
    if (capped.length > 0) {
      this.markDirty();
    }

    const results = capped.map((s) => ({
      fact: s.memory.fact,
      similarity: s.similarity,
      domain: s.memory.domain,
    }));
    if (cacheOn) this.turnSearchCache.set(query, results);
    return results;
  }

  /**
   * Clears the per-turn caches (#171): both the query→results search cache and
   * the query→embedding cache. Called by the REPL at the start of each user
   * turn so that any memory added or accessed in the previous turn is reflected
   * in the next search, and internally whenever the memory set mutates.
   */
  clearTurnCache(): void {
    this.turnSearchCache.clear();
    this.turnEmbeddingCache.clear();
  }

  /** List all facts as plain text lines. */
  listFacts(): string[] {
    const now = Date.now();
    return this.memories.map((m) => {
      const date = m.createdAt.slice(0, 10);
      const daysLeft = m.expiresAt
        ? Math.max(0, Math.ceil((new Date(m.expiresAt).getTime() - now) / 86400000))
        : '?';
      const observed = m.observedCount ? `, observed ${m.observedCount}x` : '';
      return `[${date}] [${m.domain}] (accessed ${m.accessCount}x${observed}, expires in ${daysLeft}d) ${m.fact}`;
    });
  }

  /** Clear all memories. */
  clear(): void {
    this.memories = [];
    this.persist();
    this.clearTurnCache();
  }

  /** Total number of stored memories. */
  count(): number {
    return this.memories.length;
  }

  /** Count memories grouped by domain. */
  countByDomain(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const m of this.memories) {
      counts[m.domain] = (counts[m.domain] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Search for memories relevant to the query, returning rich metadata.
   * Same scoring/grouping/capping as search() but does NOT update access metadata.
   *
   * Pass {@link RAGSearchOverrides} to widen (or narrow) the net beyond the
   * store's configured defaults — the recall-filter pass uses this to retrieve
   * a broad candidate set that a downstream LLM then prunes. Access metadata is
   * intentionally left untouched; callers that commit to a subset should call
   * {@link recordAccess} for exactly the facts they keep.
   */
  async searchWithIds(
    query: string,
    overrides?: RAGSearchOverrides,
  ): Promise<RAGSearchResultWithId[]> {
    if (this.memories.length === 0) return [];

    const queryEmbedding = await this.embedQuery(query, 'rag:searchWithIds');
    if (!queryEmbedding) return [];

    const capped = this.scoreAndRank(query, queryEmbedding, overrides);

    return capped.map((s) => ({
      id: s.memory.id,
      fact: s.memory.fact,
      similarity: s.similarity,
      domain: s.memory.domain,
      createdAt: s.memory.createdAt,
      accessCount: s.memory.accessCount,
    }));
  }

  /** Return all memories as RAGSearchResultWithId (similarity=1.0 placeholder). */
  listMemories(): RAGSearchResultWithId[] {
    return this.memories.map((m) => ({
      id: m.id,
      fact: m.fact,
      similarity: 1.0,
      domain: m.domain,
      createdAt: m.createdAt,
      accessCount: m.accessCount,
    }));
  }

  /** Delete memories by ID. Returns the number of memories deleted. */
  deleteByIds(ids: string[]): number {
    const idSet = new Set(ids);
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => !idSet.has(m.id));
    const deleted = before - this.memories.length;
    if (deleted > 0) {
      this.clearTurnCache();
      this.persist();
    }
    return deleted;
  }

  /** Remove facts whose expiresAt has passed. Returns the number removed. */
  private pruneExpired(): number {
    const now = Date.now();
    const before = this.memories.length;
    this.memories = this.memories.filter(
      (m) => !m.expiresAt || new Date(m.expiresAt).getTime() > now,
    );
    const expired = before - this.memories.length;
    if (expired > 0) {
      this.clearTurnCache();
      debugLog('rag:pruneExpired', { expired });
      this.persist();
    }
    return expired;
  }

  /**
   * Prune memories if over the cap.
   * First removes expired facts, then applies capacity-based scoring.
   * Score = recency decay (half-life 90 days) + log2(accessCount + 1)
   * Keeps top N by score.
   */
  private prune(): void {
    this.pruneExpired();

    if (this.memories.length <= this.maxMemories) return;

    const now = Date.now();
    const halfLifeMs = PRUNE_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;

    const scored = this.memories.map((m) => {
      const ageMs = now - new Date(m.createdAt).getTime();
      const recency = Math.pow(0.5, ageMs / halfLifeMs);
      const access = Math.log2(m.accessCount + 1);
      // **Repetition outweighs retrieval, and that is the point of #525.**
      // `accessCount` says a fact is topically adjacent to what gets asked;
      // `observedCount` says it was independently learned again, which is the
      // stronger evidence that it is durable. Weighted above retrieval rather
      // than merely added, so a fact observed twice beats one retrieved twice.
      //
      // It has a reader here on purpose. `source` and `lastAccessed` are both
      // written by this store and read by NOTHING, and a third write-only field
      // would be the same defect: the observation would be recorded and still
      // could not save the record from a prune.
      const observed = Math.log2((m.observedCount ?? 0) + 1) * 2;
      return { memory: m, score: recency + access + observed };
    });

    scored.sort((a, b) => b.score - a.score);
    this.memories = scored.slice(0, this.maxMemories).map((s) => s.memory);

    debugLog('rag:prune', { kept: this.memories.length });
  }

  /** Load memories from disk. Backfills domain, expiresAt, and compensates for idle days. */
  private load(): void {
    try {
      if (!fs.existsSync(MEMORIES_FILE)) return;
      const data = fs.readFileSync(MEMORIES_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      // Two shapes, and the legacy one is not deprecated — it is what every
      // existing install has on disk (#520). A bare array is a store written
      // before the stamp existed: read it, adopt it, and let `needsStamp`
      // write the stamp back on the same constructor pass. No migration script.
      const records: unknown = Array.isArray(parsed) ? parsed : parsed?.memories;
      if (Array.isArray(parsed)) {
        this.needsStamp = true;
      } else if (parsed && typeof parsed === 'object') {
        this.stamp = { model: parsed.model, dimensions: parsed.dimensions };
      }
      if (Array.isArray(records)) {
        this.memories = records.map((m: any) => ({
          ...m,
          domain: m.domain ?? DEFAULT_DOMAIN,
          embedding: Array.isArray(m.embedding) ? m.embedding : Object.values(m.embedding),
        }));
      }
    } catch (err) {
      debugLog(
        'rag:load',
        `Failed to load memories: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.memories = [];
      return;
    }

    if (this.memories.length === 0) return;

    let dirty = false;

    // Backfill expiresAt for legacy facts without one (must run before idle-day shift)
    const now = Date.now();
    const ttlMs = this.ragTtlDays * 86400000;
    const gracePeriodMs = 14 * 86400000;

    for (const m of this.memories) {
      if (!m.expiresAt) {
        const ageMs = now - new Date(m.createdAt).getTime();
        const remainingMs = ttlMs - ageMs;
        m.expiresAt = new Date(now + Math.max(remainingMs, gracePeriodMs)).toISOString();
        dirty = true;
      }
    }

    // Compensate for idle days — TTL only counts days Bernard was used
    const idleDays = this.getIdleDays();
    if (idleDays > 0) {
      const shiftMs = idleDays * 86400000;
      for (const m of this.memories) {
        if (m.expiresAt) {
          m.expiresAt = new Date(new Date(m.expiresAt).getTime() + shiftMs).toISOString();
        }
      }
      debugLog('rag:load', { idleDaysCompensated: idleDays });
      dirty = true;
    }

    if (dirty || this.needsStamp) {
      this.persist();
    }
  }

  /**
   * Refuses to search when the store was written by a different embedding
   * model (#520).
   *
   * The failure this replaces was **silent**: `cosineSimilarity` returns `0`
   * for vectors of different lengths, `0` is below every threshold, so
   * `search()` returned `[]` — no error, no log, a store of thousands of facts
   * reading as empty. `dimensions()`, the interface method that would have
   * caught it, existed with **zero production callers**. This is its first.
   *
   * **Refuse, do not discard.** `CACHE_SCHEMA_VERSION` is the template for the
   * stamp, but its mismatch path returns `null` and refetches — right for a
   * disposable model catalogue, wrong here: these are thousands of records
   * derived from the user's own conversations. A mismatch stops retrieval and
   * says why, leaving re-embedding or an explicit `bernard facts clear` as the
   * user's call.
   *
   * An unstamped legacy store is NOT a mismatch — it is every install that
   * predates this — so it is adopted, stamped and trusted. That is a real
   * assumption worth naming: a model swapped before the stamp existed cannot
   * be detected.
   */
  private modelMismatch(provider: EmbeddingProvider): string | null {
    if (!this.stamp?.model) return null;
    if (this.stamp.model === provider.modelId() && this.stamp.dimensions === provider.dimensions())
      return null;
    return (
      `This memory store was written by ${this.stamp.model} at ${this.stamp.dimensions} dimensions, ` +
      `but the active embedder is ${provider.modelId()} at ${provider.dimensions()}. ` +
      `Vectors from different models score zero against each other, so every search would return ` +
      `nothing. The ${this.memories.length} stored facts are intact — re-embed them, or run ` +
      '`bernard facts clear` to start over.'
    );
  }

  /**
   * Records the mismatch and logs it; **does not print**.
   *
   * `debugLog` alone would reproduce the original defect one level up — the
   * whole point is that this failure was invisible without `BERNARD_DEBUG` —
   * but a `console.error` from here is the wrong channel and would be invisible
   * for a different reason. RAG search runs mid-turn (`recall-filter`, the main
   * agent's own retrieval), and in the default full-screen REPL Ink owns the
   * alternate screen buffer: a raw stderr write at the cursor corrupts the
   * current frame and is then overwritten on Ink's next ~32 ms render. The
   * warning deliberately made "loud enough to be seen" would be the one most
   * likely not to be seen.
   *
   * So this module exposes STATE and lets each front end surface it in its own
   * channel — `catalog-notice.ts`'s `provider-wiped` precedent exactly, and for
   * the same stated reason: "your retrieval is returning nothing" has to
   * outlive a keystroke, so the REPL pushes a transcript notice rather than a
   * toast, and `runHeadless` writes it to the job log where an operator will
   * read it later.
   */
  private warnMismatchOnce(message: string): void {
    debugLog('rag:model-mismatch', { message });
    this.disabledReason = message;
  }

  /**
   * Why retrieval is returning nothing, or `null` when it is healthy.
   *
   * Latched on first detection and never cleared: the condition is a property
   * of the store on disk versus the active embedder, and neither changes
   * within a process.
   */
  retrievalDisabledReason(): string | null {
    return this.disabledReason;
  }

  /**
   * Compute the number of idle calendar days since the last session.
   * Returns 0 if no previous session recorded or if used today/yesterday.
   */
  private getIdleDays(): number {
    try {
      if (!fs.existsSync(LAST_SESSION_FILE)) return 0;
      const lastDateStr = fs.readFileSync(LAST_SESSION_FILE, 'utf-8').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDateStr)) return 0;

      const todayStr = new Date().toISOString().slice(0, 10);
      const lastDate = new Date(lastDateStr + 'T00:00:00Z');
      const today = new Date(todayStr + 'T00:00:00Z');
      const daysBetween = Math.round((today.getTime() - lastDate.getTime()) / 86400000);

      // 0 = same day, 1 = consecutive days (normal), 2+ = idle gap
      return Math.max(0, daysBetween - 1);
    } catch {
      return 0;
    }
  }

  /** Write today's date as the last session date. */
  private saveSessionDate(): void {
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(LAST_SESSION_FILE, todayStr, 'utf-8');
    } catch {
      // Non-critical — just log
      debugLog('rag:saveSessionDate', 'Failed to save session date');
    }
  }

  /**
   * The BM25 index for `corpus`, built on first use and reused while it lasts.
   *
   * **Keyed on `(memories, domainScope)`, not on the corpus array's identity.**
   * Unscoped, `corpus === this.memories` and identity would work — but a scoped
   * view (#511) builds `this.memories.filter(...)`, a NEW array on every call,
   * so an identity key never hit and every scoped query rebuilt the whole
   * index. Measured on the real store: 21–25 ms per query for the three large
   * domains, against a 1.7 ms cosine scan, and since #532 retrieval runs once
   * per dispatch — so a four-way fan-out paid it four times.
   *
   * Both key fields are stable for the life of a view: `scoped()` computes its
   * scope once, and every path that changes membership reassigns `this.memories`
   * wholesale, so identity still invalidates correctly.
   */
  private lexicalIndex(corpus: readonly RAGMemory[]): LexicalIndex {
    const c = this.lexicalCache;
    if (c && c.memories === this.memories && c.scope === this.domainScope) return c.index;
    const index = new LexicalIndex(corpus.map((m) => m.fact));
    this.lexicalCache = { memories: this.memories, scope: this.domainScope, index };
    return index;
  }

  /**
   * Records that access bookkeeping is pending, and schedules a flush (#533).
   *
   * The timer is a backstop for a long-lived process that never exits cleanly
   * — the cron daemon, a REPL killed with SIGKILL. The flush that actually
   * matters is the explicit one at each exit hook.
   */
  private markDirty(): void {
    const st = this.persistState;
    st.dirty = true;
    if (st.timer) return;
    st.timer = setTimeout(() => {
      st.timer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    // Never keep the process alive for bookkeeping.
    st.timer.unref?.();
  }

  /**
   * Credits a record for having been observed again (#525).
   *
   * **Not `bumpAccess`.** That one records a RETRIEVAL and drives the
   * entrenchment loop #372 is about — retrieved, bumped, more likely retrieved.
   * This records an independent OBSERVATION, which is the strongest evidence
   * available that a fact is durable, and it must not be swept up by the cap
   * and decay #372 applies to `accessCount`.
   *
   * The TTL extension is shared in spirit but computed off `observedCount`, so
   * a fact re-learned across many sessions outlives one that was merely
   * retrieved often. Monotone: an extension never shortens an existing expiry.
   *
   * `source` is updated because the newer observation is the better-evidenced
   * one — a fact re-observed at exit has stronger provenance than the same
   * fact from a compression pass. (`source` has no reader today; it is written
   * so that when one arrives it describes the latest evidence, not the first.)
   */
  private reinforce(memory: RAGMemory, source: string, now: string, nowMs: number): void {
    memory.observedCount = (memory.observedCount ?? 0) + 1;
    memory.source = source;
    memory.lastAccessed = now;
    extendExpiry(
      memory,
      Math.min(this.ragTtlDays, this.ragTtlDays * 0.5 + Math.log2(memory.observedCount + 1) * 7),
      nowMs,
    );
  }

  /**
   * Writes pending access bookkeeping, if any.
   *
   * Public because `persist` is private and had no external caller — there was
   * no way for a process to say "I am about to exit". Callers: the REPL's
   * cleanup save loop, `runHeadless`'s `finally`, and the exit worker.
   * Idempotent and cheap when nothing is dirty.
   */
  flush(): void {
    const st = this.persistState;
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    if (!st.dirty) return;
    this.persist();
  }

  /**
   * Persist memories to disk atomically (write to tmp, then rename).
   *
   * Through `atomicWriteFileSyncUnique`, not a hand-rolled pair (#533). A
   * UNIQUE temp name is required here rather than `fs-utils`' fixed `.tmp`
   * suffix: four processes write this file — the REPL, the detached exit
   * worker, the cron daemon and `bernard facts` — so a shared temp path means
   * two concurrent persists write the same file and rename it twice, and
   * debouncing widens the window that makes it matter.
   *
   * **The unlink-on-failure half is what makes a unique name safe**, and is why
   * the shared helper is worth reaching for rather than copying it a fifth
   * time. A fixed suffix left one orphan that the next write overwrote; a
   * unique one leaves a distinct ~31 MB file per failure, and
   * {@link cleanupStaleTemp} sweeps only `.pending-*.json`, so nothing would
   * ever collect them.
   */
  private persist(): void {
    this.persistState.dirty = false;
    this.needsStamp = false;
    // Stamped, so a later reader can tell which model wrote these vectors
    // (#520). `CACHE_SCHEMA_VERSION` is the template for the shape; the
    // difference is what a mismatch DOES — see `modelMismatch`.
    const payload: StoredMemories = {
      version: STORE_SCHEMA_VERSION,
      model: this.stamp?.model ?? EMBEDDING_MODEL_ID,
      dimensions: this.stamp?.dimensions ?? EMBEDDING_DIMENSIONS,
      memories: this.memories,
    };
    const failure = atomicWriteFileSyncUnique(MEMORIES_FILE, JSON.stringify(payload));
    if (failure) debugLog('rag:persist', `Failed to persist memories: ${failure}`);
  }
}
