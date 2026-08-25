import { describe, it, expect, beforeEach } from 'vitest';
import { classifyError } from '../error-taxonomy.js';
import {
  stallGuardedFetch,
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
