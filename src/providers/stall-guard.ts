import { debugLog } from '../logger.js';

/**
 * Default time-to-first-byte budget for an LLM completion, in milliseconds.
 *
 * Sized from measurement, not intuition. Across 1,230 instrumented completion
 * requests the observed TTFB was p50 1.8 s, p99 13.3 s, **max 27.4 s** — so
 * 90 s leaves 3.3x headroom over the worst legitimate case while failing 3.3x
 * sooner than the accidental default it replaces (undici's 300 s
 * `headersTimeout`, which is what a stalled xAI request actually hit in #302).
 *
 * Deliberately a *first-byte* budget rather than a whole-request one: a
 * reasoning model can legitimately spend minutes generating after the headers
 * arrive, and killing that would be a regression. Once the response object
 * exists this guard is done — the body streams untimed.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 90_000;

/**
 * Message fragment every stall error carries.
 *
 * Load-bearing in two places: `error-taxonomy.ts` classifies any message
 * matching /timed?\s*out/ as `timeout` (giving us the user-facing playbook and
 * `retryable` for free), and the phrasing is what the user actually reads in
 * the error panel.
 */
const STALL_MARKER = 'timed out';

/**
 * The configured first-byte budget, from `BERNARD_PROVIDER_STALL_TIMEOUT_MS`.
 *
 * Env-only, not profile-scoped: this is a process-level transport property, and
 * the clients it configures are built once at module load — a mid-session
 * profile switch could not re-apply it anyway.
 *
 * Mirrors `parseDispatchTimeoutMs` in `framework/runner.ts`: unparseable or
 * `<= 0` disables the guard rather than falling back to the default, so
 * `BERNARD_PROVIDER_STALL_TIMEOUT_MS=0` is a real off switch.
 */
export function resolveStallTimeoutMs(): number {
  const raw = process.env.BERNARD_PROVIDER_STALL_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_STALL_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** True when `err` is the abort a caller's own signal produced, not ours. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Wraps `fetch` with a time-to-first-byte cap (#302).
 *
 * A provider can accept the POST and then go silent — no headers, no bytes, and
 * no error for the AI SDK to surface. Nothing in Bernard bounded that: the only
 * backstop was undici's 300 s `headersTimeout`, and since `maxRetries` defaults
 * to 2 the SDK would then try twice more, so a single stall could cost ~15
 * minutes of a wedged REPL.
 *
 * The returned fetch aborts the request if the response headers have not
 * arrived within `timeoutMs`, and throws a plain `Error` — **never an
 * `AbortError`**. That distinction matters: the REPL treats `AbortError` as
 * "the user pressed Esc" and renders nothing at all, so surfacing a stall as an
 * abort would silently swallow the turn, which is worse than the bug. A plain
 * error carrying {@link STALL_MARKER} reaches the error panel and classifies
 * itself as `timeout`.
 *
 * A caller-supplied `signal` still wins: if it fires first the underlying
 * `AbortError` propagates untouched, so Esc keeps looking like Esc.
 *
 * @param timeoutMs Budget in ms. `0` or negative disables the guard entirely
 *   (returns the underlying fetch unwrapped).
 * @param baseFetch Injectable for tests; defaults to the global `fetch`.
 */
export function stallGuardedFetch(
  timeoutMs: number = DEFAULT_STALL_TIMEOUT_MS,
  baseFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return baseFetch;

  return async function stallGuarded(input, init) {
    const controller = new AbortController();
    const caller = init?.signal ?? undefined;

    const onCallerAbort = () => controller.abort();
    if (caller) {
      if (caller.aborted) controller.abort();
      else caller.addEventListener('abort', onCallerAbort, { once: true });
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    // Never hold the event loop open on this timer's account — mirrors the
    // dispatch watchdog in `framework/runner.ts`.
    timer.unref?.();

    try {
      // Only the header await is guarded. Once this resolves the response
      // exists and the body is the caller's problem.
      return await baseFetch(input, { ...init, signal: controller.signal });
    } catch (err) {
      // Ours, not theirs: our controller fired and the caller's signal did not.
      // Same discrimination `model-validate.ts` uses for its probe timeout.
      if (timedOut && !caller?.aborted && isAbortError(err)) {
        const seconds = Math.round(timeoutMs / 1000);
        debugLog('provider:stall', { timeoutMs, url: safeTarget(input) });
        throw new Error(
          `Provider ${STALL_MARKER} — no response headers within ${seconds}s. ` +
            `The connection was accepted but never answered. ` +
            `Retry, or switch provider/lineup if it persists.`,
          { cause: err },
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (caller) caller.removeEventListener('abort', onCallerAbort);
    }
  };
}

/**
 * Host + path of a fetch target for the debug log, or `undefined` if it cannot
 * be parsed. Query strings are dropped — they can carry credentials, and the
 * instrumented-fetch privacy contract (host/path/method/status/bytes/timings
 * only, never query, headers, or bodies) applies here too.
 */
function safeTarget(input: RequestInfo | URL): string | undefined {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw);
    return `${u.host}${u.pathname}`;
  } catch {
    return undefined;
  }
}
