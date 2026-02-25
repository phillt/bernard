import * as path from 'node:path';
import * as os from 'node:os';
import { debugLog } from './logger.js';

/** Abstraction over a text embedding model used by the RAG subsystem. */
export interface EmbeddingProvider {
  /** Compute embedding vectors for one or more text strings. */
  embed(texts: string[]): Promise<number[][]>;
  /** Return the dimensionality of the embedding vectors produced by this provider. */
  dimensions(): number;
}

let cachedProvider: EmbeddingProvider | null | undefined;

/**
 * Lazily load fastembed and return an EmbeddingProvider.
 * Returns null if fastembed is unavailable or fails to initialize.
 * Caches the result after first call.
 */
export async function getEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  if (cachedProvider !== undefined) return cachedProvider;

  try {
    const { EmbeddingModel, FlagEmbedding } = await import('fastembed');
    const model = await FlagEmbedding.init({
      model: EmbeddingModel.AllMiniLML6V2,
      cacheDir: path.join(os.homedir(), '.bernard', 'models'),
      showDownloadProgress: false,
    });

    cachedProvider = {
      async embed(texts: string[]): Promise<number[][]> {
        const results: number[][] = [];
        for await (const batch of model.embed(texts)) {
          results.push(...batch);
        }
        return results;
      },
      dimensions(): number {
        return 384;
      },
    };

    return cachedProvider;
  } catch (err) {
    debugLog(
      'embeddings:init',
      `Failed to load fastembed: ${err instanceof Error ? err.message : String(err)}`,
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
