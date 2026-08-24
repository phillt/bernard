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
 * Env-only, not profile-scoped: this is a process-level transport property.
 * Read per request rather than at module load, so a value in `.env` (parsed
 * later, by `loadConfig`) is honored.
 *
 * Mirrors `parseDispatchTimeoutMs` in `framework/runner.ts`: unparseable or
 * `<= 0` disables the guard rather than falling back to the default, so
 * `BERNARD_PROVIDER_STALL_TIMEOUT_MS=0` is a real off switch.
 */
export function resolveStallTimeoutMs(): number {
  const raw = process.env.BERNARD_PROVIDER_STALL_TIMEOUT_MS;
  if (!raw) return DEFAULT_STALL_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
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
 * @param getTimeoutMs Budget resolver, called per request. Returning `0` or a
 *   negative value passes the request straight through unguarded.
 * @param baseFetch Injectable for tests; otherwise the live `globalThis.fetch`
 *   is read per request (see the note in the body).
 */
export function stallGuardedFetch(
  getTimeoutMs: () => number = resolveStallTimeoutMs,
  baseFetch?: typeof fetch,
): typeof fetch {
  return async function stallGuarded(input, init) {
    // Both of these resolve PER REQUEST, never at module load. That is not
    // fussiness — capturing either one at construction broke something real:
    //
    //  - `globalThis.fetch`: this module is evaluated during ESM import, but
    //    `installInstrumentedFetchIfDebug()` patches the global later, from
    //    inside a Commander action. Capturing early pinned the pre-patch fetch
    //    and silently killed `http:request:start` / `http:response:headers` /
    //    `http:response:end` for every provider call — the exact events
    //    CLAUDE.md names for telling a network hang from a stream that never
    //    closed. Resolving late also gives the right layering: the debug patch
    //    observes, this wrapper enforces policy, stacked in that order.
    //  - the budget: `dotenv.config()` runs inside `loadConfig()`, later still,
    //    so a value in `~/.config/bernard/.env` had no effect and only a real
    //    shell export worked. Every other knob here reads lazily.
    const fetchImpl = baseFetch ?? globalThis.fetch;
    const timeoutMs = getTimeoutMs();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetchImpl(input, init);

    const caller = init?.signal ?? undefined;
    // `AbortSignal.timeout` aborts with a `TimeoutError`, distinct from the
    // `AbortError` a caller's own signal produces — so the runtime does the
    // "was this mine or theirs?" discrimination that would otherwise need a
    // mutable flag and a three-way condition. `any` also handles an
    // already-aborted caller, and neither signal holds the event loop open.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;

    try {
      // Only the header await is guarded. Once this resolves the response
      // exists and the body streams untimed — a reasoning model generating for
      // minutes must not be killed. The body stays bound to `signal`, so a
      // later caller abort still tears the socket down.
      return await fetchImpl(input, { ...init, signal });
    } catch (err) {
      if (timeout.aborted && !caller?.aborted) {
        const seconds = Math.round(timeoutMs / 1000);
        debugLog('provider:stall', { timeoutMs, url: safeTarget(input) });
        // Deliberately a plain `Error`, which buys two things. The REPL renders
        // nothing for an `AbortError` (it means "the user pressed Esc"), so a
        // bare abort would silently swallow the turn. And the AI SDK only
        // retries a `TypeError('fetch failed')` wrapped as a retryable
        // `APICallError` — so this error is never retried, which is what
        // actually bounds a dead connection at ONE budget rather than three.
        throw new Error(
          `Provider ${STALL_MARKER} — no response headers within ${seconds}s. ` +
            `The connection was accepted but never answered. ` +
            `Retry, or switch provider/lineup if it persists.`,
          { cause: err },
        );
      }
      throw err;
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
    const u = new URL(input instanceof Request ? input.url : input);
    return `${u.host}${u.pathname}`;
  } catch {
    return undefined;
  }
}
