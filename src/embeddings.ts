import * as fs from 'node:fs';
import { debugLog } from './logger.js';
import { MODELS_DIR } from './paths.js';
import { DEFAULT_BODY_IDLE_TIMEOUT_MS } from './providers/stall-guard.js';

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

/**
 * The load, in flight or settled — a PROMISE rather than a result (#607).
 *
 * It used to be the result alone, assigned after `await pipeline(...)`, so two
 * concurrent callers both saw `undefined` and both loaded. Measured: two
 * `pipeline()` calls against a cold cache emit eight `download` events for four
 * files and return two different objects — transformers.js does no deduplication
 * of its own — so a pair of concurrent dispatches fetched 46 MB instead of 23.
 * Concurrent callers are ordinary here: `withSlot` allows four dispatches and
 * each one's RAG search awaits this.
 *
 * Sharing the promise also decides where the deadline belongs. The budget is
 * attached to the LOAD, not to a caller: if it expires, the load really did go
 * quiet for everyone waiting on it, and every waiter gets the same answer. The
 * slot is then cleared so the next call starts a fresh one — see
 * {@link EmbeddingLoadAbandoned}.
 */
let load: Promise<EmbeddingProvider | null> | undefined;

/** See {@link embeddingUnavailableReason}. */
let unavailableReason: string | null = null;

/**
 * Embedding vector dimensionality for all-MiniLM-L6-v2.
 *
 * Exported since #516 so a store can stamp itself without awaiting the provider
 * — `rag.ts` keeps a private copy for exactly that reason (its `persist` is
 * synchronous and `getEmbeddingProvider` is not), and a third copy would be one
 * too many. That copy could now import this; changing it is not this PR's
 * business and is noted rather than smuggled in.
 */
export const EMBEDDING_DIMENSIONS = 384;

/**
 * The model id, exported so a persisted store can be stamped with it (#520).
 *
 * Hardcoded, like `EMBEDDING_DIMENSIONS` — `EmbeddingProvider` is an interface built to
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
 * Idle budget for loading the embedding model, in ms — the gap between two
 * signs of progress, never the total time the load takes (#607).
 *
 * ## Why this exists
 *
 * The first call may DOWNLOAD the model, and nothing timed that out. It is
 * reachable from a dispatch's own tool (`knowledge`, and every RAG search), so
 * a dispatch could sit here forever with the runner's liveness guard correctly
 * paused for a tool call — the pause was right and the inner bound was missing.
 *
 * ## Why inactivity rather than a duration
 *
 * Measured on this machine: warm, 180 ms; cold, **1.2–1.7 s** for a 23 MB
 * download at ~18 MB/s. The same 23 MB is ~3 minutes at 1 Mbit/s and ~12 at
 * 256 kbit/s, so a duration budget has no defensible value — anything that
 * survives a slow link is not a bound, and anything that bounds is a hair
 * trigger on one. That is #350's argument about a response body, and this IS a
 * response body.
 *
 * So the clock measures silence, and `pipeline`'s `progress_callback` — which
 * this file previously passed as an explicit `undefined` — is the signal.
 * Measured: 1,478 events over 1,170 ms cold with a **maximum gap of 279 ms**,
 * 17 events over 123 ms warm with a maximum gap of 55 ms, and a tail silence of
 * **zero** in both, because `ready` fires last. One number covers both regimes
 * with nothing fitted to either.
 *
 * ## The number
 *
 * {@link DEFAULT_BODY_IDLE_TIMEOUT_MS}, imported rather than restated, because
 * it is the same question about the same kind of bytes: the gap between two
 * chunks of an HTTP response body past which the connection is dead. Not an
 * analogy — a model download is one. 430x the worst gap measured here.
 *
 * `0` (or a non-numeric value) disables, matching every other liveness budget.
 *
 * The parse is byte-identical to `runner.ts`'s `parseLivenessBudgetMs` and a
 * near-twin of this module's own `resolveStallTimeoutMs` / `resolveBodyIdleTimeoutMs`,
 * which return `0` for disabled where these two return `null`. Four copies, two
 * conventions. Not unified here: sharing with `runner.ts` would give this file an
 * edge to the `ai` package for a six-line parse, and reconciling the two
 * conventions changes the contract of two functions that argue for theirs in
 * place. Noted rather than smuggled into a review fix.
 *
 * **Exported for a test, and a mutation check is why** — the precedent
 * `App.tsx`'s `pickWizardField` sets. The off switch's only behavioural
 * discriminator is "does it still fire at the 120 s default", which needs fake
 * timers; under them the case passes in isolation and passes under the mutation
 * when the whole file runs, so it asserts nothing. The parse is where the
 * decision is, and it can be asserted exactly.
 */
export function embeddingIdleTimeoutMs(): number | null {
  const raw = process.env.BERNARD_EMBEDDING_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_BODY_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * The load went quiet and was abandoned.
 *
 * A distinct class rather than a message match, because the two failures need
 * opposite caching. A library that will not import is a property of the install
 * and is cached forever; a load that went quiet is not, and caching it would
 * turn one bad minute into a process that can never embed again — for the cron
 * daemon and the applet host, days.
 *
 * **Abandoned, not cancelled.** `pipeline()` takes no `AbortSignal`, so the
 * race is the whole of what is available and the background load keeps running.
 * That is the better residue here rather than merely the only one: transformers.js
 * writes each file only once it has the whole buffer, so an interrupted load
 * leaves completed files on disk and no partial one — verified by killing a cold
 * load mid-download and loading again from the same cache, which reused the three
 * finished files and re-fetched only the missing model. Whatever the background
 * load finishes, a retry does not have to.
 */
class EmbeddingLoadAbandoned extends Error {
  constructor(idleMs: number, budgetMs: number) {
    super(
      `the embedding model went quiet for ${idleMs} ms while loading, so the load was ` +
        `abandoned (BERNARD_EMBEDDING_IDLE_TIMEOUT_MS=${budgetMs}). The first use downloads ` +
        `the model; files that finished are kept, so running this again continues where it ` +
        `stopped rather than starting over.`,
    );
    this.name = 'EmbeddingLoadAbandoned';
  }
}

/**
 * Runs the load, bounded by silence rather than by elapsed time.
 *
 * The timer RESCHEDULES itself against the last progress stamp instead of being
 * cleared and re-armed on every event: a cold load emits 1,478 of them, and
 * this way it arms a handful of timers rather than 1,478 pairs.
 */
async function withIdleDeadline<T>(
  budgetMs: number | null,
  run: (onProgress: () => void) => Promise<T>,
): Promise<T> {
  let lastProgressAt = Date.now();
  const work = run(() => {
    lastProgressAt = Date.now();
  });
  if (budgetMs === null) return work;
  // The abandoned load outlives this race by design, so its eventual rejection
  // must never surface as an unhandled one.
  work.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const arm = (fn: () => void, ms: number): void => {
    timer = setTimeout(fn, ms);
    // Never a reason the process cannot exit: the load itself is holding the
    // loop open for as long as it matters.
    timer.unref?.();
  };
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        const tick = (): void => {
          const idle = Date.now() - lastProgressAt;
          if (idle < budgetMs) arm(tick, budgetMs - idle);
          else reject(new EmbeddingLoadAbandoned(idle, budgetMs));
        };
        arm(tick, budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Why the embedding model is unavailable, or `null` when it is fine.
 *
 * `getEmbeddingProvider` answers `null` for two failures a caller must be able
 * to tell apart — a library that will not load, and a download that was cut
 * off — and a caller that reports "unavailable" for both sends the user after
 * the wrong problem. Modelled on `RAGStore.retrievalDisabledReason`: state
 * rather than a print, because this can be reached from a background pass while
 * Ink owns the screen.
 *
 * Unlike that one it is deliberately NOT latched. A model mismatch is a property
 * of the store on disk and cannot change within a process; an abandoned download
 * can succeed on the very next call, so this describes the most recent attempt
 * and is cleared by a load that works.
 */
export function embeddingUnavailableReason(): string | null {
  return unavailableReason;
}

/**
 * Lazily load @xenova/transformers and return an EmbeddingProvider.
 * Returns null if the library is unavailable, fails to initialize, or goes
 * quiet for {@link embeddingIdleTimeoutMs} — see {@link embeddingUnavailableReason}
 * for which. The load is shared by concurrent callers and cached after it
 * succeeds; an abandoned one is not cached, so the next call retries it.
 */
export function getEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  // NOT `async`, and that is the difference between sharing being a behaviour
  // and sharing being observable. An `async` wrapper mints a fresh promise per
  // call, so two callers of one load hold two different objects and the only way
  // to see that they share is to count `pipeline` invocations afterwards —
  // which is a measurement any other test's straggler can perturb. Returning the
  // memoized promise itself makes `getEmbeddingProvider() === getEmbeddingProvider()`
  // true synchronously, with no microtask in between for anything to interleave.
  // Safe because the body has no `await` and `loadProvider` is `async`, so it
  // can never throw synchronously where this previously would have rejected.
  return (load ??= loadProvider());
}

async function loadProvider(): Promise<EmbeddingProvider | null> {
  try {
    const { pipeline } = await import('@xenova/transformers');
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    debugLog('embeddings:init', 'Loading embedding model (may download on first run)...');
    const extractor = await withIdleDeadline(embeddingIdleTimeoutMs(), (onProgress) =>
      pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
        cache_dir: MODELS_DIR,
        progress_callback: onProgress,
      }),
    );

    unavailableReason = null;
    return {
      async embed(texts: string[]): Promise<number[][]> {
        warnIfTruncated(texts);
        const output = await extractor(texts, { pooling: 'mean', normalize: true });
        const data = output.data as Float32Array;
        const results: number[][] = [];
        for (let i = 0; i < texts.length; i++) {
          results.push(
            Array.from(data.slice(i * EMBEDDING_DIMENSIONS, (i + 1) * EMBEDDING_DIMENSIONS)),
          );
        }
        return results;
      },
      dimensions(): number {
        return EMBEDDING_DIMENSIONS;
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
  } catch (err) {
    if (err instanceof EmbeddingLoadAbandoned) {
      debugLog('embeddings:abandoned', err.message);
      unavailableReason = err.message;
      // Deliberately NOT cached. The slot is cleared so the next call starts a
      // fresh load — which, thanks to what the background one has written by
      // then, is usually cheaper than the first.
      load = undefined;
      return null;
    }
    const message = err instanceof Error ? err.message : String(err);
    debugLog('embeddings:init', `Failed to load @xenova/transformers: ${message}`);
    unavailableReason = `the embedding library could not be loaded (${message})`;
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
  load = undefined;
  unavailableReason = null;
  truncationWarned = false;
}
