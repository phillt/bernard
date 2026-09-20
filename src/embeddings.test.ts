import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cosineSimilarity,
  getEmbeddingProvider,
  embeddingUnavailableReason,
  embeddingIdleTimeoutMs,
  _resetEmbeddingProvider,
} from './embeddings.js';
import { DEFAULT_BODY_IDLE_TIMEOUT_MS } from './providers/stall-guard.js';
import { pipeline } from '@xenova/transformers';

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
}));

// `vi.hoisted`, because the `vi.mock` factory below is hoisted above every
// import and #607's cases need a handle on `pipeline` itself — importing it at
// the top moved the factory's evaluation ahead of this declaration.
const { mockExtractor } = vi.hoisted(() => ({
  mockExtractor: vi.fn().mockResolvedValue({
    data: new Float32Array(384), // single embedding of zeros
    dims: [1, 384],
  }),
}));

vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(mockExtractor),
}));

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('returns 0 for zero-length vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  it('computes correct value for non-trivial vectors', () => {
    // cos(45°) ≈ 0.7071
    const a = [1, 0];
    const b = [1, 1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(Math.SQRT1_2, 4);
  });
});

describe('getEmbeddingProvider', () => {
  beforeEach(() => {
    _resetEmbeddingProvider();
  });

  it('returns a valid provider when @xenova/transformers is available', async () => {
    const provider = await getEmbeddingProvider();
    expect(provider).not.toBeNull();
    expect(typeof provider!.embed).toBe('function');
    expect(typeof provider!.dimensions).toBe('function');
    expect(provider!.dimensions()).toBe(384);
  });

  it('caches the provider on subsequent calls', async () => {
    const first = await getEmbeddingProvider();
    const second = await getEmbeddingProvider();
    expect(first).toBe(second);
  });

  it('reshapes output into per-text vectors', async () => {
    mockExtractor.mockResolvedValueOnce({
      data: new Float32Array([...Array(384).fill(1), ...Array(384).fill(2)]),
      dims: [2, 384],
    });
    const provider = await getEmbeddingProvider();
    const results = await provider!.embed(['a', 'b']);
    expect(results).toHaveLength(2);
    expect(results[0]).toHaveLength(384);
    expect(results[0][0]).toBe(1);
    expect(results[1][0]).toBe(2);
  });
});

describe('the model is identifiable, and the ceiling is visible (#520)', () => {
  it('names the model that produced its vectors', async () => {
    // Without this the question "which model wrote this store?" is
    // unanswerable from disk, which is why a swap was silent.
    const { getEmbeddingProvider, EMBEDDING_MODEL_ID } = await import('./embeddings.js');
    const provider = await getEmbeddingProvider();
    if (!provider) return; // no model cached in this environment
    expect(provider.modelId()).toBe(EMBEDDING_MODEL_ID);
  });

  it('states the sequence limit in word pieces, not characters', async () => {
    // 256, not the 512 #520 assumes — and #515/#517/#518 are being shaped
    // around this number, so it is worth pinning rather than inferring.
    const { EMBEDDING_MAX_WORD_PIECES, MAX_EMBED_CHARS } = await import('./embeddings.js');
    expect(EMBEDDING_MAX_WORD_PIECES).toBe(256);
    expect(MAX_EMBED_CHARS).toBe(1024);
  });

  it('warns once when input is past the ceiling', async () => {
    const logger = await import('./logger.js');
    const spy = vi.spyOn(logger, 'debugLog');
    const { getEmbeddingProvider, MAX_EMBED_CHARS, _resetEmbeddingProvider } =
      await import('./embeddings.js');
    _resetEmbeddingProvider();
    const provider = await getEmbeddingProvider();
    if (!provider) return;
    spy.mockClear();
    await provider.embed(['x'.repeat(MAX_EMBED_CHARS + 1)]);
    await provider.embed(['y'.repeat(MAX_EMBED_CHARS + 1)]);
    const warns = spy.mock.calls.filter((c) => c[0] === 'embeddings:truncated');
    // Once per process, because this runs in a loop over every fact.
    expect(warns).toHaveLength(1);
    spy.mockRestore();
  });

  it('stays quiet for input the model can actually read', async () => {
    const logger = await import('./logger.js');
    const spy = vi.spyOn(logger, 'debugLog');
    const { getEmbeddingProvider, _resetEmbeddingProvider } = await import('./embeddings.js');
    _resetEmbeddingProvider();
    const provider = await getEmbeddingProvider();
    if (!provider) return;
    spy.mockClear();
    await provider.embed(['a short fact']);
    expect(spy.mock.calls.filter((c) => c[0] === 'embeddings:truncated')).toHaveLength(0);
    spy.mockRestore();
  });
});

/**
 * A promise this file settles by hand.
 *
 * Every case below that needs a load to be "still running" uses one instead of
 * a real timer. A `setTimeout(…, 20)` makes the assertion a measurement of how
 * busy the machine is, which this batch has already produced three of.
 */
class Deferred {
  readonly promise: Promise<unknown>;
  resolve!: (value: unknown) => void;
  constructor() {
    this.promise = new Promise((r) => {
      this.resolve = r;
    });
  }
}

/**
 * The model load is bounded by SILENCE (#607). It is reachable from a
 * dispatch's own tool, so an unbounded one is a dispatch that can sit forever
 * with the runner's liveness guard correctly paused for a tool call.
 */
describe('the model load is bounded, and by inactivity (#607)', () => {
  const pipelineMock = pipeline as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetEmbeddingProvider();
    // Call counts are per-case here, not per-file. Without this every
    // `toHaveBeenCalledTimes` below counts every load the file has ever done —
    // an assertion whose expected value is whatever order the suite ran in.
    pipelineMock.mockClear();
    delete process.env.BERNARD_EMBEDDING_IDLE_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.BERNARD_EMBEDDING_IDLE_TIMEOUT_MS;
    pipelineMock.mockResolvedValue(mockExtractor);
  });

  async function withIdleBudget<T>(ms: string, fn: () => Promise<T>): Promise<T> {
    process.env.BERNARD_EMBEDDING_IDLE_TIMEOUT_MS = ms;
    try {
      return await fn();
    } finally {
      delete process.env.BERNARD_EMBEDDING_IDLE_TIMEOUT_MS;
    }
  }

  it('abandons a load that goes quiet, and says that is what happened', async () => {
    pipelineMock.mockImplementation(() => new Promise(() => {}));
    await withIdleBudget('60', async () => {
      expect(await getEmbeddingProvider()).toBeNull();
    });
    // "Unavailable" is what a caller said for this AND for a library that will
    // not import — two failures with opposite remedies. The point of the reason
    // is that it names the download and says a retry continues it.
    const reason = embeddingUnavailableReason();
    expect(reason).toMatch(/went quiet/);
    expect(reason).toMatch(/continues where it stopped/);
  });

  it('never cuts a load that is still making progress, however long it takes', async () => {
    // The whole reason the clock measures silence rather than elapsed time.
    // Cold is 1.2-1.7 s here at ~18 MB/s and minutes on a slow link; a duration
    // budget that survives the slow link is not a bound, and one that bounds is
    // a hair trigger on it. This load runs far past its budget and is not cut.
    pipelineMock.mockImplementation(
      (_task: string, _model: string, opts: { progress_callback?: () => void }) =>
        new Promise((resolve) => {
          let beats = 0;
          const beat = setInterval(() => {
            opts.progress_callback?.();
            if (++beats >= 12) {
              clearInterval(beat);
              resolve(mockExtractor);
            }
          }, 20);
        }),
    );
    await withIdleBudget('60', async () => {
      expect(await getEmbeddingProvider()).not.toBeNull();
    });
    expect(embeddingUnavailableReason()).toBeNull();
  });

  it('does not cache an abandoned load, so the next call retries it', async () => {
    // A library that will not import is a property of the install and is cached
    // forever; a load that went quiet is not. Caching it would turn one bad
    // minute into a process that can never embed again — days, for the cron
    // daemon and the applet host.
    pipelineMock.mockImplementation(() => new Promise(() => {}));
    await withIdleBudget('60', async () => {
      expect(await getEmbeddingProvider()).toBeNull();
    });
    pipelineMock.mockResolvedValue(mockExtractor);
    expect(await getEmbeddingProvider()).not.toBeNull();
    expect(embeddingUnavailableReason()).toBeNull();
  });

  it('shares one load between concurrent callers', async () => {
    // Measured before this: two `pipeline()` calls against a cold cache emit
    // eight download events for four files and return two different objects —
    // transformers.js dedupes nothing — so a pair of concurrent dispatches
    // fetched 46 MB instead of 23. Four dispatches run concurrently by default
    // and each one's RAG search awaits this.
    //
    // **Asserted on promise IDENTITY, synchronously, and with no real timer.**
    // The first cut counted `pipeline` invocations across three awaited calls,
    // which is a measurement of the whole process rather than of these three
    // callers: it went red in CI because a straggling load from the case below
    // resumed inside this one's window and called `pipeline` a second time. No
    // microtask can run between these three lines, so nothing anywhere can
    // perturb them. The call count stays as a second assertion — it is
    // deterministic now that nothing leaks — but it is no longer what the case
    // rests on.
    const deferred = new Deferred();
    pipelineMock.mockImplementation(() => deferred.promise);
    const p1 = getEmbeddingProvider();
    const p2 = getEmbeddingProvider();
    const p3 = getEmbeddingProvider();
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);

    deferred.resolve(mockExtractor);
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('reads `0` as off, and a typo as off rather than as the default', () => {
    // Asserted on the PARSE, not on the guard. The only behavioural
    // discriminator is whether it still fires at the 120 s default, which needs
    // fake timers — and under them the case passes in isolation AND passes
    // under the mutation when the whole file runs, so it asserts nothing. This
    // one cannot pass under a `0`-falls-back-to-the-default mutation.
    const read = (v: string | undefined): number | null => {
      if (v === undefined) delete process.env.BERNARD_EMBEDDING_IDLE_TIMEOUT_MS;
      else process.env.BERNARD_EMBEDDING_IDLE_TIMEOUT_MS = v;
      try {
        return embeddingIdleTimeoutMs();
      } finally {
        delete process.env.BERNARD_EMBEDDING_IDLE_TIMEOUT_MS;
      }
    };
    expect(read(undefined)).toBe(DEFAULT_BODY_IDLE_TIMEOUT_MS);
    expect(read('')).toBe(DEFAULT_BODY_IDLE_TIMEOUT_MS);
    expect(read('0')).toBeNull();
    expect(read('-5')).toBeNull();
    expect(read('nonsense')).toBeNull();
    expect(read('250')).toBe(250);
  });

  it('does not fire at the default once it is off', async () => {
    // **Fake timers, because the fallback is 120 s and the assertion has to be
    // able to fail.** Waiting 200 ms of real time and finding the load still
    // running is true whether `0` disabled the guard or silently fell back to
    // the default — a test that cannot fail, which is how the same case was
    // first written for `BERNARD_DISPATCH_STALL_TIMEOUT_MS` too. Advancing past
    // the default is what discriminates. (The parse is pinned separately above;
    // this case pins that the parse reaches the guard.)
    //
    // **It also has to leave nothing behind, which is what broke CI.** It used
    // to `void` the load and never settle it, so on a loaded machine the load
    // had not yet reached `pipeline` when the clock was advanced — the case
    // passed while proving nothing — and the straggler then called `pipeline`
    // inside a LATER test, whose own assertion counted it. Hence the two
    // additions: wait on real time until the load has actually started, so
    // advancing the clock means something; and resolve it at the end, so the
    // load finishes inside the case that owns it.
    const deferred = new Deferred();
    pipelineMock.mockImplementation(() => deferred.promise);
    process.env.BERNARD_EMBEDDING_IDLE_TIMEOUT_MS = '0';
    const loading = getEmbeddingProvider();
    let settled = false;
    void loading.then(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(pipelineMock).toHaveBeenCalledTimes(1));
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(130_000);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
      delete process.env.BERNARD_EMBEDDING_IDLE_TIMEOUT_MS;
      deferred.resolve(mockExtractor);
      await loading;
    }
  });
});
