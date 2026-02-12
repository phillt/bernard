import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getEmbeddingProvider, cosineSimilarity } from './embeddings.js';
import { debugLog } from './logger.js';

const RAG_DIR = path.join(os.homedir(), '.bernard', 'rag');
const MEMORIES_FILE = path.join(RAG_DIR, 'memories.json');

const DEFAULT_TOP_K = 5;
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
  createdAt: string;
  accessCount: number;
  lastAccessed?: string;
}

export interface RAGSearchResult {
  fact: string;
  similarity: number;
}

export interface RAGStoreConfig {
  topK?: number;
  similarityThreshold?: number;
  maxMemories?: number;
}

export class RAGStore {
  private memories: RAGMemory[] = [];
  private topK: number;
  private similarityThreshold: number;
  private maxMemories: number;

  constructor(config?: RAGStoreConfig) {
    this.topK = config?.topK ?? DEFAULT_TOP_K;
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
  async addFacts(facts: string[], source: string): Promise<number> {
    if (facts.length === 0) return 0;

    const provider = await getEmbeddingProvider();
    if (!provider) {
      debugLog('rag:addFacts', 'No embedding provider available, skipping');
      return 0;
    }

    let embeddings: number[][];
    try {
      embeddings = await provider.embed(facts);
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
        createdAt: now,
        accessCount: 0,
      });
      added++;
    }

    if (added > 0) {
      this.prune();
      this.persist();
    }

    debugLog('rag:addFacts', { added, total: this.memories.length });
    return added;
  }

  /**
   * Search for memories relevant to the query.
   * Returns top-k results above the similarity threshold, sorted by similarity.
   */
  async search(query: string): Promise<RAGSearchResult[]> {
    if (this.memories.length === 0) return [];

    const provider = await getEmbeddingProvider();
    if (!provider) return [];

    let queryEmbedding: number[];
    try {
      const embeddings = await provider.embed([query]);
      queryEmbedding = embeddings[0];
    } catch (err) {
      debugLog('rag:search', `Query embedding failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }

    const scored = this.memories
      .map((m) => ({
        memory: m,
        similarity: cosineSimilarity(queryEmbedding, m.embedding),
      }))
      .filter((s) => s.similarity >= this.similarityThreshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.topK);

    // Update access metadata
    const now = new Date().toISOString();
    for (const { memory } of scored) {
      memory.accessCount++;
      memory.lastAccessed = now;
    }
    if (scored.length > 0) {
      this.persist();
    }

    return scored.map((s) => ({
      fact: s.memory.fact,
      similarity: s.similarity,
    }));
  }

  /** List all facts as plain text lines. */
  listFacts(): string[] {
    return this.memories.map((m) => {
      const date = m.createdAt.slice(0, 10);
      return `[${date}] (accessed ${m.accessCount}x) ${m.fact}`;
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

  /** Load memories from disk. */
  private load(): void {
    try {
      if (!fs.existsSync(MEMORIES_FILE)) return;
      const data = fs.readFileSync(MEMORIES_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        this.memories = parsed;
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
