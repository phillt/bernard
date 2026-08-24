import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyError } from '../../error-taxonomy.js';
import { stallGuardedFetch, DEFAULT_STALL_TIMEOUT_MS } from '../stall-guard.js';

/**
 * #302: a provider can accept the POST and never send headers. The only
 * backstop was undici's 300 s default, times `maxRetries: 2` — ~15 minutes of
 * wedged REPL. These pin the guard that replaces it.
 */

/** A fetch that never resolves until its signal aborts — the #302 condition. */
function stalledFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    })) as unknown as typeof fetch;
}

/** A fetch whose headers land after `ms`. */
function slowHeaders(ms: number): typeof fetch {
  return ((_input: RequestInfo | URL, _init?: RequestInit) =>
    new Promise((resolve) => {
      setTimeout(() => resolve(new Response('ok')), ms);
    })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('stallGuardedFetch (#302)', () => {
  it('aborts a stalled request at the budget and reports it as a timeout', async () => {
    vi.useFakeTimers();
    const guarded = stallGuardedFetch(90_000, stalledFetch());
    const p = guarded('https://api.x.ai/v1/chat/completions');
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(90_001);
    await assertion;
  });

  it('does NOT throw an AbortError — that would silently swallow the turn', async () => {
    // The REPL renders nothing for `AbortError` (it means "user pressed Esc"),
    // so a bare abort here would be strictly worse than the bug it fixes.
    vi.useFakeTimers();
    const guarded = stallGuardedFetch(1_000, stalledFetch());
    const p = guarded('https://api.x.ai/v1/chat/completions').then(
      () => null,
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(1_001);
    const err = (await p) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe('AbortError');
  });

  it('produces a message the error taxonomy classifies as `timeout`', async () => {
    vi.useFakeTimers();
    const guarded = stallGuardedFetch(1_000, stalledFetch());
    const p = guarded('https://api.x.ai/v1/chat/completions').then(
      () => null,
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(1_001);
    const err = (await p) as Error;
    // No taxonomy change needed: the message carries "timed out".
    expect(classifyError({ message: err.message }).category).toBe('timeout');
  });

  it('lets a slow-but-healthy response through', async () => {
    vi.useFakeTimers();
    const guarded = stallGuardedFetch(90_000, slowHeaders(27_400)); // observed worst TTFB
    const p = guarded('https://api.x.ai/v1/chat/completions');
    await vi.advanceTimersByTimeAsync(27_401);
    await expect(p).resolves.toBeInstanceOf(Response);
  });

  it("preserves the caller's abort as an AbortError, so Esc still reads as Esc", async () => {
    const ctrl = new AbortController();
    const guarded = stallGuardedFetch(90_000, stalledFetch());
    const p = guarded('https://api.x.ai/v1/chat/completions', { signal: ctrl.signal }).then(
      () => null,
      (e: unknown) => e,
    );
    ctrl.abort();
    const err = (await p) as Error;
    expect(err.name).toBe('AbortError');
    expect(err.message).not.toMatch(/timed out/i);
  });

  it('rejects immediately when the caller signal is already aborted', async () => {
    const guarded = stallGuardedFetch(90_000, stalledFetch());
    const err = (await guarded('https://x.test', {
      signal: AbortSignal.abort(),
    }).then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    expect(err.name).toBe('AbortError');
  });

  it('passes through unwrapped when disabled', () => {
    const base = stalledFetch();
    expect(stallGuardedFetch(0, base)).toBe(base);
    expect(stallGuardedFetch(-1, base)).toBe(base);
    expect(stallGuardedFetch(Number.NaN, base)).toBe(base);
  });

  it('leaves no pending timer once a request completes', async () => {
    vi.useFakeTimers();
    const guarded = stallGuardedFetch(90_000, slowHeaders(10));
    const p = guarded('https://x.test');
    await vi.advanceTimersByTimeAsync(11);
    await p;
    // The guard's timer must be cleared, not merely unref'd.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defaults to a budget well clear of the observed worst legitimate TTFB', () => {
    // 27.4 s measured max across 1,230 real requests; 300 s was undici's.
    expect(DEFAULT_STALL_TIMEOUT_MS).toBeGreaterThan(27_400 * 2);
    expect(DEFAULT_STALL_TIMEOUT_MS).toBeLessThan(300_000);
  });
});
