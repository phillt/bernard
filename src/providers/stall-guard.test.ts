import { describe, it, expect, beforeEach } from 'vitest';
import { classifyError, providerStallInfo } from '../error-taxonomy.js';
import {
  stallGuardedFetch,
  withStallBudget,
  DEFAULT_STALL_TIMEOUT_MS,
  resolveStallTimeoutMs,
} from './stall-guard.js';
import { getProviderRequestCount, _resetProviderRequestCountForTests } from './request-counter.js';

/**
 * #302: a provider can accept the POST and never send headers. The only
 * backstop was undici's 300 s default, and because that surfaces as
 * `TypeError: fetch failed` the AI SDK treated it as retryable — 3 attempts,
 * ~15 minutes of wedged REPL.
 *
 * Real timers throughout, with tiny budgets: vitest's fake timers do not drive
 * `AbortSignal.timeout`, so faking them would silently test nothing.
 */

/** A fetch that never answers until its signal aborts — the #302 condition. */
function stalledFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const fail = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) return fail();
      signal.addEventListener('abort', fail, { once: true });
    })) as unknown as typeof fetch;
}

/** A fetch whose headers land after `ms`. */
function slowHeaders(ms: number): typeof fetch {
  return (() =>
    new Promise((resolve) =>
      setTimeout(() => resolve(new Response('ok')), ms),
    )) as unknown as typeof fetch;
}

/** The rejection from a guarded call, or `null` if it unexpectedly resolved. */
async function rejectionOf(p: Promise<unknown>): Promise<Error> {
  return (await p.then(
    () => null,
    (e: unknown) => e,
  )) as Error;
}

describe('stallGuardedFetch (#302)', () => {
  it('aborts a stalled request and reports it in a form the UI will show', async () => {
    const err = await rejectionOf(
      stallGuardedFetch(() => 20, stalledFetch())('https://api.x.ai/v1/x'),
    );

    expect(err.message).toMatch(/timed out/i);
    // Three properties of one rejection, each load-bearing:
    // 1. NOT an AbortError — the REPL renders nothing for those ("user pressed
    //    Esc"), so a bare abort would silently swallow the turn.
    expect(err.name).not.toBe('AbortError');
    // 2. NOT a TypeError('fetch failed') — that is the only shape the AI SDK
    //    wraps as a retryable APICallError. Being unretryable is what bounds a
    //    dead connection at ONE budget instead of three.
    expect(err).not.toBeInstanceOf(TypeError);
    // 3. The taxonomy classifies it with no changes of its own.
    expect(classifyError({ message: err.message }).category).toBe('timeout');
  });

  it('lets a slow-but-healthy response through', async () => {
    const res = await stallGuardedFetch(() => 200, slowHeaders(20))('https://api.x.ai/v1/x');
    expect(res).toBeInstanceOf(Response);
  });

  it("preserves the caller's abort, so Esc still reads as Esc", async () => {
    const ctrl = new AbortController();
    const p = stallGuardedFetch(() => 10_000, stalledFetch())('https://api.x.ai/v1/x', {
      signal: ctrl.signal,
    });
    ctrl.abort();
    const err = await rejectionOf(p);

    expect(err.name).toBe('AbortError');
    expect(err.message).not.toMatch(/timed out/i);
  });

  it('rejects immediately when the caller signal is already aborted', async () => {
    const err = await rejectionOf(
      stallGuardedFetch(() => 10_000, stalledFetch())('https://x.test', {
        signal: AbortSignal.abort(),
      }),
    );
    expect(err.name).toBe('AbortError');
  });

  it('passes the request straight through when disabled', async () => {
    let called = false;
    const base = (async () => {
      called = true;
      return new Response('ok');
    }) as unknown as typeof fetch;
    for (const off of [0, -1, Number.NaN]) {
      called = false;
      await stallGuardedFetch(() => off, base)('https://x.test');
      expect(called).toBe(true);
    }
  });

  it('reads the budget per request, so a later .env value is honored', async () => {
    // `dotenv.config()` runs inside `loadConfig()`, after this module is
    // evaluated — capturing the budget at construction made `.env` inert.
    let budget = 0; // disabled at construction time
    const guarded = stallGuardedFetch(() => budget, stalledFetch());
    budget = 20; // ...as if loadConfig had since parsed .env
    const err = await rejectionOf(guarded('https://x.test'));
    expect(err.message).toMatch(/timed out/i);
  });

  it('uses the live globalThis.fetch, so the debug patch still sees provider calls', async () => {
    // `installInstrumentedFetchIfDebug()` patches the global from inside a
    // Commander action, long after this module is imported. Capturing
    // `globalThis.fetch` early silently disabled the `http:*` events that
    // CLAUDE.md documents for diagnosing exactly this class of hang.
    const guarded = stallGuardedFetch(() => 10_000); // no baseFetch: use the global
    const original = globalThis.fetch;
    let sawPatch = false;
    globalThis.fetch = (async () => {
      sawPatch = true;
      return new Response('ok');
    }) as unknown as typeof fetch;
    try {
      await guarded('https://x.test');
    } finally {
      globalThis.fetch = original;
    }
    expect(sawPatch).toBe(true);
  });
});

describe('resolveStallTimeoutMs', () => {
  const withEnv = (value: string | undefined, run: () => void) => {
    const prev = process.env.BERNARD_PROVIDER_STALL_TIMEOUT_MS;
    if (value === undefined) delete process.env.BERNARD_PROVIDER_STALL_TIMEOUT_MS;
    else process.env.BERNARD_PROVIDER_STALL_TIMEOUT_MS = value;
    try {
      run();
    } finally {
      if (prev === undefined) delete process.env.BERNARD_PROVIDER_STALL_TIMEOUT_MS;
      else process.env.BERNARD_PROVIDER_STALL_TIMEOUT_MS = prev;
    }
  };

  it('defaults when unset or empty', () => {
    withEnv(undefined, () => expect(resolveStallTimeoutMs()).toBe(DEFAULT_STALL_TIMEOUT_MS));
    withEnv('', () => expect(resolveStallTimeoutMs()).toBe(DEFAULT_STALL_TIMEOUT_MS));
  });

  it('honors an explicit override', () => {
    withEnv('5000', () => expect(resolveStallTimeoutMs()).toBe(5000));
  });

  it('treats 0 and unparseable values as off, not as the default', () => {
    // A user setting `0` means "disable", and must not silently get 90 s.
    withEnv('0', () => expect(resolveStallTimeoutMs()).toBe(0));
    withEnv('-1', () => expect(resolveStallTimeoutMs()).toBe(0));
    withEnv('nonsense', () => expect(resolveStallTimeoutMs()).toBe(0));
  });
});

/**
 * #308: the provider billed 87 requests for a session Bernard recorded 22 calls
 * for. The counter has to live under the SDK's retry loop and be on by default,
 * or it can only observe a session someone already suspected.
 */
describe('provider request counting (#308)', () => {
  beforeEach(() => _resetProviderRequestCountForTests());

  it('counts every request the wrapper issues', async () => {
    const guarded = stallGuardedFetch(() => 5_000, slowHeaders(0));
    await guarded('https://api.example/v1/messages');
    await guarded('https://api.example/v1/messages');
    expect(getProviderRequestCount()).toBe(2);
  });

  it('keeps counting when the stall guard itself is disabled', async () => {
    // `BERNARD_PROVIDER_STALL_TIMEOUT_MS=0` is a real off switch for the guard.
    // It must not also silently switch off request accounting.
    const guarded = stallGuardedFetch(() => 0, slowHeaders(0));
    await guarded('https://api.example/v1/messages');
    expect(getProviderRequestCount()).toBe(1);
  });

  it('counts a request that fails, since the provider still billed the attempt', async () => {
    const guarded = stallGuardedFetch(() => 20, stalledFetch());
    await rejectionOf(guarded('https://api.example/v1/messages'));
    expect(getProviderRequestCount()).toBe(1);
  });
});

/**
 * A fetch whose body delivers `chunks` at `gapMs` intervals, then either closes
 * or goes silent forever. Headers land immediately — the shape of every case
 * below, since body inactivity is by definition something that happens after
 * the header budget has already been satisfied and cleared.
 */
function bodyFetch(chunks: string[], gapMs: number, thenSilent: boolean): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        // A real `fetch` binds the body to `init.signal`; a double that ignores
        // it cannot exercise the caller-abort path at all — it passes by
        // hanging, which is how a meaningless assertion gets written.
        const onAbort = (): void => {
          try {
            c.error(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          } catch {
            /* already closed */
          }
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        for (const chunk of chunks) {
          await new Promise((r) => setTimeout(r, gapMs));
          if (signal?.aborted) return;
          c.enqueue(new TextEncoder().encode(chunk));
        }
        if (thenSilent) await new Promise(() => {});
        c.close();
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  }) as unknown as typeof fetch;
}

describe('body-inactivity guard (#350)', () => {
  /**
   * THE REGRESSION CASE. The budget this replaces was an `AbortSignal.timeout`
   * passed as `init.signal`, which stays bound for the whole response lifetime
   * and so was a hard deadline on the body. Real traffic came within 4.5 s of
   * it — a step measured 85,447 ms returning 1,295 bytes, i.e. a reasoning
   * model working correctly.
   *
   * Six chunks 40 ms apart is 240 ms of body against a 100 ms budget: a
   * deadline kills it, an INACTIVITY clock never trips because every chunk
   * restamps it. That difference is the entire fix, so it is asserted first.
   */
  it('does not kill a body that keeps delivering, past the budget', async () => {
    const guarded = stallGuardedFetch(
      () => 1_000,
      bodyFetch(['a', 'b', 'c', 'd', 'e', 'f'], 40, false),
      () => 100,
    );
    const res = await guarded('https://api.x.ai/v1/x');
    await expect(res.text()).resolves.toBe('abcdef');
  });

  /**
   * THE LEAK ITSELF. The header budget used to be an `AbortSignal.timeout`
   * handed to `fetch` as `init.signal`, and a signal given to `fetch` stays
   * bound for the whole response lifetime — so the first-byte timer went on
   * running and killed the BODY at the header budget.
   *
   * The condition needs all three of: a SHORT header budget, headers that beat
   * it, and a body that then legitimately outlives it. Every other test here
   * uses a generous header budget and finishes well inside it, so none of them
   * reproduces it — verified by mutation: deleting the `clearTimeout` left the
   * rest of this file entirely green.
   */
  it('does not apply the header budget to the body once headers have arrived', async () => {
    const guarded = stallGuardedFetch(
      () => 50, // header budget: headers land at ~5 ms, body runs ~240 ms
      bodyFetch(['a', 'b', 'c', 'd', 'e', 'f'], 40, false),
      () => 500,
    );
    const res = await guarded('https://api.x.ai/v1/x');
    await expect(res.text()).resolves.toBe('abcdef');
  });

  it('kills a body that goes silent, as a stall the UI will show', async () => {
    const guarded = stallGuardedFetch(
      () => 1_000,
      bodyFetch(['a'], 5, true),
      () => 60,
    );
    const res = await guarded('https://api.x.ai/v1/x');
    const err = await rejectionOf(res.text());

    expect(err.message).toMatch(/timed out/i);
    // Same three properties the header stall is pinned on: not an AbortError
    // (the REPL renders nothing for those), not a TypeError (that shape is what
    // the AI SDK retries, which would multiply with our own loop), and it earns
    // the `timeout` category with no new vocabulary.
    expect(err.name).not.toBe('AbortError');
    expect(err).not.toBeInstanceOf(TypeError);
    expect(classifyError({ message: err.message }).category).toBe('timeout');
  });

  it('reports whether the body had produced anything, which decides retryability', async () => {
    const silentFromTheStart = stallGuardedFetch(
      () => 1_000,
      bodyFetch([], 5, true),
      () => 60,
    );
    const none = await rejectionOf((await silentFromTheStart('https://x/1')).text());
    expect(providerStallInfo(none)).toEqual({ phase: 'body', producedOutput: false });

    // A chunk that reached the SDK may already have become a `text-delta` on
    // the user's screen, and `OutputSink` has no reset — so any chunk at all
    // makes this unsafe to re-issue.
    const spokeThenDied = stallGuardedFetch(
      () => 1_000,
      bodyFetch(['hello'], 5, true),
      () => 60,
    );
    const some = await rejectionOf((await spokeThenDied('https://x/2')).text());
    expect(providerStallInfo(some)).toEqual({ phase: 'body', producedOutput: true });
  });

  it('leaves the response cloneable', async () => {
    // #350 names this as the risk of re-wrapping a body in a TransformStream.
    // The AI SDK clones responses, so breaking it would break every provider
    // call rather than only a stalled one.
    const guarded = stallGuardedFetch(
      () => 1_000,
      bodyFetch(['x', 'y'], 1, false),
      () => 500,
    );
    const res = await guarded('https://api.x.ai/v1/x');
    const copy = res.clone();
    await expect(res.text()).resolves.toBe('xy');
    await expect(copy.text()).resolves.toBe('xy');
  });

  it('keeps a caller abort during the body reading as a caller abort', async () => {
    // The guard composes the caller's signal in via `AbortSignal.any`, which is
    // what keeps Esc reaching the socket mid-body. If that were dropped when
    // the header timer was cleared, Esc would stop working the moment headers
    // arrived.
    const ctrl = new AbortController();
    const guarded = stallGuardedFetch(
      () => 1_000,
      bodyFetch(['a'], 5, true),
      () => 5_000,
    );
    const res = await guarded('https://api.x.ai/v1/x', { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    const err = await rejectionOf(res.text());
    expect(err.message).not.toMatch(/timed out/i);
  });

  it('is disabled by an explicit 0, like its sibling budget', async () => {
    const guarded = stallGuardedFetch(
      () => 1_000,
      bodyFetch(['a'], 5, true),
      () => 0,
    );
    const res = await guarded('https://api.x.ai/v1/x');
    const raced = await Promise.race([
      res.text().then(() => 'finished'),
      new Promise((r) => setTimeout(() => r('still-running'), 200)),
    ]);
    expect(raced).toBe('still-running');
  });
});

describe('withStallBudget', () => {
  it('shortens a budget', async () => {
    // 1000 ms configured, 30 ms override: the request must die on the override.
    const err = await rejectionOf(
      withStallBudget(30, () => stallGuardedFetch(() => 1_000, stalledFetch())('https://x/1')),
    );
    expect(err.message).toMatch(/timed out/i);
  });

  it('cannot lengthen one', async () => {
    // 20 ms configured, 5000 ms override. If the override won, this would hang
    // and the race would report 'still-running'. It must NOT — a mechanism that
    // can lengthen a liveness budget from inside a retry can defeat the guard.
    const raced = await withStallBudget(5_000, () =>
      Promise.race([
        rejectionOf(stallGuardedFetch(() => 20, stalledFetch())('https://x/1')).then(
          (e) => e.message,
        ),
        new Promise<string>((r) => setTimeout(() => r('still-running'), 300)),
      ]),
    );
    expect(raced).toMatch(/timed out/i);
  });

  it('cannot re-enable a disabled guard', async () => {
    // `BERNARD_PROVIDER_STALL_TIMEOUT_MS=0` is a real off switch and an
    // override must not quietly undo it.
    const raced = await withStallBudget(20, () =>
      Promise.race([
        stallGuardedFetch(
          () => 0,
          stalledFetch(),
          () => 0,
        )('https://x/1').then(() => 'finished'),
        new Promise<string>((r) => setTimeout(() => r('still-running'), 200)),
      ]),
    );
    expect(raced).toBe('still-running');
  });
});
