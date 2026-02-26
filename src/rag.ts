import * as fs from 'node:fs';
import * as path from 'node:path';
import { getEmbeddingProvider, cosineSimilarity } from './embeddings.js';
import { debugLog } from './logger.js';
import { DEFAULT_DOMAIN } from './domains.js';
import { RAG_DIR, MEMORIES_FILE, LAST_SESSION_FILE } from './paths.js';

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
    const now = new Date().toISOString();

    for (let i = 0; i < facts.length; i++) {
      const fact = facts[i];
      const embedding = embeddings[i];

      // Deduplicate: skip if too similar to an existing memory
      const isDuplicate = this.memories.some(
        (m) => cosineSimilarity(m.embedding, embedding) > DEDUP_THRESHOLD,
      );
      if (isDuplicate) {
        debugLog('rag:dedup', `Skipping duplicate fact: ${fact.slice(0, 80)}`);
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
    }

    debugLog('rag:addFacts', { added, total: this.memories.length, domain });
    return added;
  }

  /**
   * Score, group by domain (top-k per domain), and cap at maxResults.
   * Shared by search() and searchWithIds().
   */
  private scoreAndRank(queryEmbedding: number[]): { memory: RAGMemory; similarity: number }[] {
    const scored = this.memories
      .map((m) => ({
        memory: m,
        similarity: cosineSimilarity(queryEmbedding, m.embedding),
      }))
      .filter((s) => s.similarity >= this.similarityThreshold)
      .sort((a, b) => b.similarity - a.similarity);

    const byDomain = new Map<string, typeof scored>();
    for (const entry of scored) {
      const d = entry.memory.domain;
      if (!byDomain.has(d)) byDomain.set(d, []);
      const group = byDomain.get(d)!;
      if (group.length < this.topKPerDomain) {
        group.push(entry);
      }
    }

    const merged = Array.from(byDomain.values()).flat();
    merged.sort((a, b) => b.similarity - a.similarity);
    return merged.slice(0, this.maxResults);
  }

  /** Embed a query string, returning the embedding vector or null on failure. */
  private async embedQuery(query: string, logLabel: string): Promise<number[] | null> {
    const provider = await getEmbeddingProvider();
    if (!provider) return null;

    try {
      return Array.from((await provider.embed([query]))[0]);
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

    const queryEmbedding = await this.embedQuery(query, 'rag:search');
    if (!queryEmbedding) return [];

    const capped = this.scoreAndRank(queryEmbedding);

    debugLog('rag:search', { query: query.slice(0, 100), returned: capped.length });

    // Update access metadata and extend expiration
    const now = new Date().toISOString();
    const nowMs = Date.now();
    for (const { memory } of capped) {
      memory.accessCount++;
      memory.lastAccessed = now;

      // Extend expiresAt: base of 7d + log scaling by access count, capped at half TTL
      const extensionDays = Math.min(
        this.ragTtlDays * 0.5,
        7 + Math.log2(memory.accessCount + 1) * 3,
      );
      const newExpiry = nowMs + extensionDays * 86400000;
      if (!memory.expiresAt || newExpiry > new Date(memory.expiresAt).getTime()) {
        memory.expiresAt = new Date(newExpiry).toISOString();
      }
    }
    if (capped.length > 0) {
      this.persist();
    }

    return capped.map((s) => ({
      fact: s.memory.fact,
      similarity: s.similarity,
      domain: s.memory.domain,
    }));
  }

  /** List all facts as plain text lines. */
  listFacts(): string[] {
    const now = Date.now();
    return this.memories.map((m) => {
      const date = m.createdAt.slice(0, 10);
      const daysLeft = m.expiresAt
        ? Math.max(0, Math.ceil((new Date(m.expiresAt).getTime() - now) / 86400000))
        : '?';
      return `[${date}] [${m.domain}] (accessed ${m.accessCount}x, expires in ${daysLeft}d) ${m.fact}`;
    });
  }

  /** Clear all memories. */
  clear(): void {
    this.memories = [];
    this.persist();
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
   */
  async searchWithIds(query: string): Promise<RAGSearchResultWithId[]> {
    if (this.memories.length === 0) return [];

    const queryEmbedding = await this.embedQuery(query, 'rag:searchWithIds');
    if (!queryEmbedding) return [];

    const capped = this.scoreAndRank(queryEmbedding);

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
      return { memory: m, score: recency + access };
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
      if (Array.isArray(parsed)) {
        this.memories = parsed.map((m: any) => ({
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

    if (dirty) {
      this.persist();
    }
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

  /** Persist memories to disk atomically (write to tmp, then rename). */
  private persist(): void {
    try {
      const tmpFile = MEMORIES_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(this.memories), 'utf-8');
      fs.renameSync(tmpFile, MEMORIES_FILE);
    } catch (err) {
      debugLog(
        'rag:persist',
        `Failed to persist memories: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
