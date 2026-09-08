import * as fs from 'node:fs';
import { debugLog } from './logger.js';
import { MODELS_DIR } from './paths.js';

/** Abstraction over a text embedding model used by the RAG subsystem. */
export interface EmbeddingProvider {
  /** Compute embedding vectors for one or more text strings. */
  embed(texts: string[]): Promise<number[][]>;
  /** Return the dimensionality of the embedding vectors produced by this provider. */
  dimensions(): number;
  /**
   * The model that produced these vectors, for stamping a persisted store
   * (#520).
   *
   * A store written by one model and read by another scores `0` against every
   * query — see {@link cosineSimilarity} — which is below every threshold, so
   * retrieval goes silently quiet and a full store reads as empty. Recording
   * WHICH model wrote it is what lets a reader notice. Without this the
   * question "which model produced this store?" is unanswerable from the disk.
   */
  modelId(): string;
  /**
   * Exact word-piece counts, for callers that must not be truncated (#517).
   *
   * **Optional, and the optionality is the point.** Every existing test double
   * in the tree implements three methods; a required fourth would break all of
   * them for a capability only corpus ingestion needs. A caller that gets
   * `undefined` falls back to the character estimate and says so.
   *
   * Why it exists: {@link MAX_EMBED_CHARS} divides by four, which is an
   * English-prose average. Measured against this tokenizer, code runs at 2.47
   * chars per piece and Japanese at 1.00 — so a chunk sized on the estimate is
   * silently truncated on exactly the corpora a document store exists to hold.
   * Tokenizing is microseconds against ~12.9 ms of inference per chunk, so the
   * exact answer is affordable wherever it matters.
   */
  countWordPieces?(texts: string[]): Promise<number[]>;
}

let cachedProvider: EmbeddingProvider | null | undefined;

/** Embedding vector dimensionality for all-MiniLM-L6-v2. */
const DIMENSIONS = 384;

/**
 * The model id, exported so a persisted store can be stamped with it (#520).
 *
 * Hardcoded, like `DIMENSIONS` — `EmbeddingProvider` is an interface built to
 * allow a swap, but nothing configures which model is loaded, and deciding
 * whether to swap is #520's other half and stays open.
 */
export const EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

/**
 * Longest input the model actually reads, in word pieces (#520).
 *
 * all-MiniLM-L6-v2's `max_seq_length` is **256**, not the 512 the issue states
 * — and that number matters beyond this file, because #515, #517 and #518 are
 * all being shaped around a chunk-size assumption. Anything past it is
 * truncated by the tokenizer **silently**: `embed` returns a well-formed vector
 * for a prefix and the caller cannot tell.
 *
 * The existing caller-side bounds are already comfortably over it —
 * `MAX_RETRIEVAL_QUERY_CHARS` and `DEFAULT_MAX_QUERY_CHARS` are 1,000
 * characters, and `facts-cli` slices at 10,000, roughly twenty times — so
 * today's "bounds" are routinely truncated and nobody is told. Hence
 * {@link MAX_EMBED_CHARS} below and the warning it drives.
 */
export const EMBEDDING_MAX_WORD_PIECES = 256;

/**
 * Character length past which input is assumed to be truncated by the
 * tokenizer, and a warning is logged once.
 *
 * A conservative characters-per-word-piece ratio rather than a real token
 * count: counting properly means running the tokenizer twice, on a path that
 * runs per fact and per query, to produce a diagnostic. Four characters per
 * piece is the same divisor `token-estimate.ts` already uses for the same kind
 * of estimate, and erring low means the warning is early rather than absent.
 */
export const MAX_EMBED_CHARS = EMBEDDING_MAX_WORD_PIECES * 4;

/** Warn once per process, not once per fact — this runs in a loop. */
let truncationWarned = false;

/**
 * Logs once when input is long enough that the tokenizer has almost certainly
 * cut it.
 *
 * A warning rather than a refusal or a caller-side truncation: a prefix
 * embedding is still useful, and refusing would turn a quiet degradation into a
 * loud failure on a path that has been working. What was missing is that the
 * ceiling was invisible — it took an audit to notice it at all.
 */
function warnIfTruncated(texts: string[]): void {
  if (truncationWarned) return;
  const over = texts.filter((t) => t.length > MAX_EMBED_CHARS);
  if (over.length === 0) return;
  truncationWarned = true;
  debugLog('embeddings:truncated', {
    model: EMBEDDING_MODEL_ID,
    maxWordPieces: EMBEDDING_MAX_WORD_PIECES,
    approxMaxChars: MAX_EMBED_CHARS,
    longest: Math.max(...over.map((t) => t.length)),
    count: over.length,
    note: 'input past the model sequence limit is truncated silently; the vector describes a prefix',
  });
}

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
        warnIfTruncated(texts);
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
      modelId(): string {
        return EMBEDDING_MODEL_ID;
      },
      async countWordPieces(texts: string[]): Promise<number[]> {
        // The pipeline exposes its own tokenizer, so this needs no second model
        // load and no second download.
        //
        // **One string at a time, not a batch.** `truncation: false` is what
        // makes the answer useful at all — with truncation on it reports the
        // ceiling for anything over it, which is exactly the case being
        // detected — but the tokenizer then refuses a batch of differing
        // lengths outright ("you should probably activate truncation and/or
        // padding"), because it cannot build one tensor from ragged rows. And
        // padding would report the longest row's length for every row, which is
        // the same wrong answer in the other direction. Measured in
        // microseconds against ~12.9 ms of inference per chunk, so the loop
        // costs nothing where it is used.
        const out: number[] = [];
        for (const text of texts) {
          const enc = extractor.tokenizer(text, { truncation: false, padding: false });
          const dims = (enc.input_ids as { dims?: number[] }).dims;
          out.push(dims ? dims[dims.length - 1] : 0);
        }
        return out;
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
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
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
  truncationWarned = false;
}
