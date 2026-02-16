import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getEmbeddingProvider, cosineSimilarity } from './embeddings.js';
import { debugLog } from './logger.js';
import { DEFAULT_DOMAIN } from './domains.js';

const RAG_DIR = path.join(os.homedir(), '.bernard', 'rag');
const MEMORIES_FILE = path.join(RAG_DIR, 'memories.json');

const DEFAULT_TOP_K_PER_DOMAIN = 3;
const DEFAULT_MAX_RESULTS = 9;
const DEFAULT_SIMILARITY_THRESHOLD = 0.35;
const DEFAULT_MAX_MEMORIES = 5000;
const DEDUP_THRESHOLD = 0.92;
const PRUNE_HALF_LIFE_DAYS = 90;
const STALE_TEMP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export interface RAGMemory {
  id: string;
  fact: string;
  embedding: number[];
  source: string;
  domain: string;
  createdAt: string;
  accessCount: number;
  lastAccessed?: string;
}

export interface RAGSearchResult {
  fact: string;
  similarity: number;
  domain: string;
}

export interface RAGSearchResultWithId {
  id: string;
  fact: string;
  similarity: number;
  domain: string;
  createdAt: string;
  accessCount: number;
}

export interface RAGStoreConfig {
  topKPerDomain?: number;
  maxResults?: number;
  similarityThreshold?: number;
  maxMemories?: number;
}

export class RAGStore {
  private memories: RAGMemory[] = [];
  private topKPerDomain: number;
  private maxResults: number;
  private similarityThreshold: number;
  private maxMemories: number;

  constructor(config?: RAGStoreConfig) {
    this.topKPerDomain = config?.topKPerDomain ?? DEFAULT_TOP_K_PER_DOMAIN;
    this.maxResults = config?.maxResults ?? DEFAULT_MAX_RESULTS;
    this.similarityThreshold = config?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.maxMemories = config?.maxMemories ?? DEFAULT_MAX_MEMORIES;

    fs.mkdirSync(RAG_DIR, { recursive: true });
    this.load();
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
  async addFacts(facts: string[], source: string, domain: string = DEFAULT_DOMAIN): Promise<number> {
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
      debugLog('rag:addFacts', `Embedding failed: ${err instanceof Error ? err.message : String(err)}`);
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
   * Search for memories relevant to the query.
   * Per-domain top-k: takes up to topKPerDomain results per domain,
   * then merges and caps at maxResults total.
   */
  async search(query: string): Promise<RAGSearchResult[]> {
    if (this.memories.length === 0) return [];

    const provider = await getEmbeddingProvider();
    if (!provider) return [];

    let queryEmbedding: number[];
    try {
      queryEmbedding = Array.from((await provider.embed([query]))[0]);
    } catch (err) {
      debugLog('rag:search', `Query embedding failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }

    // Score all memories
    const scored = this.memories
      .map((m) => ({
        memory: m,
        similarity: cosineSimilarity(queryEmbedding, m.embedding),
      }))
      .filter((s) => s.similarity >= this.similarityThreshold)
      .sort((a, b) => b.similarity - a.similarity);

    // Group by domain, take top-k per domain
    const byDomain = new Map<string, typeof scored>();
    for (const entry of scored) {
      const d = entry.memory.domain;
      if (!byDomain.has(d)) byDomain.set(d, []);
      const group = byDomain.get(d)!;
      if (group.length < this.topKPerDomain) {
        group.push(entry);
      }
    }

    // Merge all domain groups, sort by similarity, cap at maxResults
    const merged = Array.from(byDomain.values()).flat();
    merged.sort((a, b) => b.similarity - a.similarity);
    const capped = merged.slice(0, this.maxResults);

    debugLog('rag:search', { query: query.slice(0, 100), totalScored: scored.length, returned: capped.length });

    // Update access metadata
    const now = new Date().toISOString();
    for (const { memory } of capped) {
      memory.accessCount++;
      memory.lastAccessed = now;
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
    return this.memories.map((m) => {
      const date = m.createdAt.slice(0, 10);
      return `[${date}] [${m.domain}] (accessed ${m.accessCount}x) ${m.fact}`;
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

    const provider = await getEmbeddingProvider();
    if (!provider) return [];

    let queryEmbedding: number[];
    try {
      queryEmbedding = Array.from((await provider.embed([query]))[0]);
    } catch (err) {
      debugLog('rag:searchWithIds', `Query embedding failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }

    // Score all memories
    const scored = this.memories
      .map((m) => ({
        memory: m,
        similarity: cosineSimilarity(queryEmbedding, m.embedding),
      }))
      .filter((s) => s.similarity >= this.similarityThreshold)
      .sort((a, b) => b.similarity - a.similarity);

    // Group by domain, take top-k per domain
    const byDomain = new Map<string, typeof scored>();
    for (const entry of scored) {
      const d = entry.memory.domain;
      if (!byDomain.has(d)) byDomain.set(d, []);
      const group = byDomain.get(d)!;
      if (group.length < this.topKPerDomain) {
        group.push(entry);
      }
    }

    // Merge all domain groups, sort by similarity, cap at maxResults
    const merged = Array.from(byDomain.values()).flat();
    merged.sort((a, b) => b.similarity - a.similarity);
    const capped = merged.slice(0, this.maxResults);

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

  /**
   * Prune memories if over the cap.
   * Score = recency decay (half-life 90 days) + log2(accessCount + 1)
   * Keeps top N by score.
   */
  private prune(): void {
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

  /** Load memories from disk. Backfills 'general' domain for legacy entries. */
  private load(): void {
    try {
      if (!fs.existsSync(MEMORIES_FILE)) return;
      const data = fs.readFileSync(MEMORIES_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        this.memories = parsed.map((m: any) => ({
          ...m,
          domain: m.domain ?? DEFAULT_DOMAIN,
          embedding: Array.isArray(m.embedding)
            ? m.embedding
            : Object.values(m.embedding),
        }));
      }
    } catch (err) {
      debugLog('rag:load', `Failed to load memories: ${err instanceof Error ? err.message : String(err)}`);
      this.memories = [];
    }
  }

  /** Persist memories to disk atomically (write to tmp, then rename). */
  private persist(): void {
    try {
      const tmpFile = MEMORIES_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(this.memories), 'utf-8');
      fs.renameSync(tmpFile, MEMORIES_FILE);
    } catch (err) {
      debugLog('rag:persist', `Failed to persist memories: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
