import * as fs from 'node:fs';
import { debugLog } from './logger.js';
import { MODELS_DIR } from './paths.js';

/** Abstraction over a text embedding model used by the RAG subsystem. */
export interface EmbeddingProvider {
  /** Compute embedding vectors for one or more text strings. */
  embed(texts: string[]): Promise<number[][]>;
  /** Return the dimensionality of the embedding vectors produced by this provider. */
  dimensions(): number;
}

let cachedProvider: EmbeddingProvider | null | undefined;

/** Embedding vector dimensionality for all-MiniLM-L6-v2. */
const DIMENSIONS = 384;

/**
 * Lazily load @xenova/transformers and return an EmbeddingProvider.
 * Returns null if the library is unavailable or fails to initialize.
 * Caches the result after first call.
 */
export async function getEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  if (cachedProvider !== undefined) return cachedProvider;

  try {
    const { pipeline } = await import('@xenova/transformers');
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    debugLog('embeddings:init', 'Loading embedding model (may download on first run)...');
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      cache_dir: MODELS_DIR,
      progress_callback: undefined,
    });

    cachedProvider = {
      async embed(texts: string[]): Promise<number[][]> {
        const output = await extractor(texts, { pooling: 'mean', normalize: true });
        const data = output.data as Float32Array;
        const results: number[][] = [];
        for (let i = 0; i < texts.length; i++) {
          results.push(Array.from(data.slice(i * DIMENSIONS, (i + 1) * DIMENSIONS)));
        }
        return results;
      },
      dimensions(): number {
        return DIMENSIONS;
      },
    };

    return cachedProvider;
  } catch (err) {
    debugLog(
      'embeddings:init',
      `Failed to load @xenova/transformers: ${err instanceof Error ? err.message : String(err)}`,
    );
    cachedProvider = null;
    return null;
  }
}

/** Cosine similarity between two vectors. Returns 0 for zero-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Reset cached provider — for testing only.
 * @internal
 */
export function _resetEmbeddingProvider(): void {
  cachedProvider = undefined;
}
