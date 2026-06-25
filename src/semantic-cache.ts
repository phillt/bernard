/**
 * Semantic response cache (#269, Layer 3).
 *
 * Opt-in (default off). Reuses the LOCAL embedding stack (`getEmbeddingProvider`,
 * the same model behind RAG) to match an incoming request against prior requests
 * by cosine similarity. On a near-identical hit it returns the stored answer so
 * the turn can skip the model call entirely.
 *
 * Unlike provider prompt caching (exact prefix → discount) and the exact-match
 * LLM cache (`llm-cache.ts`, exact hash → skip), this matches *similar* asks.
 * That is powerful but risky for an agent — "similar" is not "same" — so callers
 * MUST restrict it to read-only / Q&A turns (no tool actions) and the threshold
 * is intentionally high. Default off via `BERNARD_SEMANTIC_CACHE`.
 */

import { getEmbeddingProvider, cosineSimilarity } from './embeddings.js';
import { debugLog } from './logger.js';

/** Default entry lifetime: 10 minutes. */
export const DEFAULT_SEMANTIC_CACHE_TTL_MS = 10 * 60 * 1000;
/** Minimum cosine similarity for a hit. Deliberately high — near-duplicates only. */
export const DEFAULT_SEMANTIC_THRESHOLD = 0.95;
/** Cap on retained entries (oldest dropped first). */
const MAX_ENTRIES = 200;

interface Entry {
  embedding: number[];
  response: string;
  expiresAt: number;
}

export class SemanticResponseCache {
  private entries: Entry[] = [];
  /**
   * Single-slot memo of the most recently embedded query, so a `get(q)` miss
   * followed by `put(q, …)` in the same turn doesn't run the embedding model
   * twice on the same string.
   */
  private lastEmbed: { query: string; vec: number[] } | null = null;

  constructor(
    private readonly ttlMs: number = DEFAULT_SEMANTIC_CACHE_TTL_MS,
    private readonly threshold: number = DEFAULT_SEMANTIC_THRESHOLD,
  ) {}

  private prune(now: number): void {
    if (this.entries.some((e) => e.expiresAt <= now)) {
      this.entries = this.entries.filter((e) => e.expiresAt > now);
    }
  }

  private async embed(text: string): Promise<number[] | null> {
    if (this.lastEmbed?.query === text) return this.lastEmbed.vec;
    const provider = await getEmbeddingProvider();
    if (!provider) return null;
    try {
      const [vec] = await provider.embed([text]);
      if (!vec) return null;
      const arr = Array.from(vec);
      this.lastEmbed = { query: text, vec: arr };
      return arr;
    } catch {
      return null;
    }
  }

  /**
   * Return the cached response for a semantically near-identical prior query, or
   * `null` on miss / no embedding provider. Fails open (never throws).
   */
  async get(query: string): Promise<string | null> {
    const now = Date.now();
    this.prune(now);
    if (this.entries.length === 0) return null;
    const vec = await this.embed(query);
    if (!vec) return null;

    let best: { entry: Entry; sim: number } | null = null;
    for (const entry of this.entries) {
      const sim = cosineSimilarity(vec, entry.embedding);
      if (!best || sim > best.sim) best = { entry, sim };
    }
    if (best && best.sim >= this.threshold) {
      debugLog('cache:semantic:hit', { sim: Number(best.sim.toFixed(4)) });
      return best.entry.response;
    }
    debugLog('cache:semantic:miss', { best: best ? Number(best.sim.toFixed(4)) : null });
    return null;
  }

  /** Store `response` keyed by the embedding of `query`. Fails open (never throws). */
  async put(query: string, response: string): Promise<void> {
    if (!response.trim()) return;
    const vec = await this.embed(query);
    if (!vec) return;
    this.entries.push({ embedding: vec, response, expiresAt: Date.now() + this.ttlMs });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  clear(): void {
    this.entries = [];
  }

  size(): number {
    return this.entries.length;
  }
}
