import { AsyncLocalStorage } from 'node:async_hooks';

import { markProviderStall, type ProviderStallInfo } from '../error-taxonomy.js';
import { debugLog } from '../logger.js';
import { countProviderRequest } from './request-counter.js';

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
 * arrive, and killing that would be a regression.
 *
 * This block used to end "Once the response object exists this guard is done —
 * the body streams untimed", and that was **false for four months**. The budget
 * was an `AbortSignal.timeout` passed as `init.signal`, which stays bound for
 * the whole response lifetime, so it was also a hard 90 s deadline on the BODY.
 * Real traffic came within 4.5 s of it: a step measured 85,447 ms returning
 * 1,295 bytes — a reasoning model working correctly, nearly killed for it. And
 * because `await fetch(...)` had already resolved, the `catch` below never ran,
 * so what surfaced was a bare `TimeoutError` rather than any message written
 * here. {@link DEFAULT_BODY_IDLE_TIMEOUT_MS} is the budget that legitimately
 * bounds a body, and it measures inactivity rather than total duration.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 90_000;

/**
 * Default body-inactivity budget, in milliseconds — the gap between two chunks,
 * never the total time a body takes (#350).
 *
 * That distinction is the whole fix. A fixed deadline cannot tell a model
 * generating steadily for 85 s from a connection that said nothing at all, and
 * the incident this replaces was the second: HTTP 200 at 607 ms, then zero
 * bytes, forever. Measured between chunks, the first case restamps the deadline
 * on every chunk and never trips.
 *
 * 120 s matches the runner's `STREAM_STALL_TIMEOUT_MS` deliberately — the two
 * mean the same thing ("no data for two minutes") at two layers, and it sits
 * above the longest total body duration in 5,950 instrumented requests (85.4 s),
 * so even a body that stayed silent until its very last byte would survive.
 *
 * The layers overlap rather than nest, and either may win the race: this one is
 * per-request and cannot see across the several HTTP requests one `fullStream`
 * is assembled from; the runner's can, but pauses for tool execution and exists
 * only on the streaming branch. Both brand their error, so recovery treats them
 * identically and which one fired is a debug-log detail.
 */
export const DEFAULT_BODY_IDLE_TIMEOUT_MS = 120_000;

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
 * The configured body-inactivity budget, from
 * `BERNARD_PROVIDER_BODY_IDLE_TIMEOUT_MS`. Same parse rules and same off-switch
 * semantics as {@link resolveStallTimeoutMs}, deliberately — two budgets in one
 * module that disagreed about what `0` means is a trap, not a feature.
 */
export function resolveBodyIdleTimeoutMs(): number {
  const raw = process.env.BERNARD_PROVIDER_BODY_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_BODY_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const budgetOverride = new AsyncLocalStorage<number>();

/**
 * Run `fn` with both transport budgets shortened to at most `ms`.
 *
 * The recovery loop in `framework/agents/run.ts` uses this to give RETRY
 * attempts a tighter clock than the first try: attempt 1 is asking "is this
 * legitimately slow?", but attempts 2 and 3 already know the connection misbehaved
 * once, and three full-length attempts is a six-minute spinner — worse product
 * than the bug being fixed.
 *
 * An ALS rather than a parameter because the budget has to reach a `fetch` the
 * AI SDK calls on our behalf, several frames below any signature we control.
 * The established precedent is `framework/dispatch-context.ts`, which carries
 * the dispatch id across exactly the same gap for exactly the same reason.
 *
 * It can only ever SHORTEN — see {@link shorten}. A mechanism that could
 * lengthen a liveness budget from inside a retry is one that can be used to
 * defeat the guard, and `BERNARD_PROVIDER_STALL_TIMEOUT_MS=0` must stay a real
 * off switch rather than something an override quietly re-enables.
 */
export function withStallBudget<T>(ms: number, fn: () => T): T {
  return budgetOverride.run(ms, fn);
}

/**
 * The effective budget: the configured one, capped by any active override.
 *
 * `configured <= 0` returns 0 and is checked FIRST, so the off switch wins over
 * an override rather than the other way round.
 */
function shorten(configured: number): number {
  if (!Number.isFinite(configured) || configured <= 0) return 0;
  const override = budgetOverride.getStore();
  if (override === undefined || !Number.isFinite(override) || override <= 0) return configured;
  return Math.min(configured, override);
}

/**
 * Builds the error every stall throws, branded so
 * `framework/agents/run.ts` can recognise it through however many layers of AI
 * SDK rewrapping sit between here and there.
 *
 * Deliberately a plain `Error`, which buys two things. The REPL renders nothing
 * for an `AbortError` (it means "the user pressed Esc"), so a bare abort would
 * silently swallow the turn. And the AI SDK only retries a
 * `TypeError('fetch failed')` wrapped as a retryable `APICallError` — so this
 * error is never retried by the SDK, which is what keeps Bernard's own
 * three-attempt loop from multiplying with the SDK's into nine requests (the
 * over-billing #308 measured: 87 provider requests against 22 recorded calls).
 */
function stallError(
  info: ProviderStallInfo,
  timeoutMs: number,
  input: RequestInfo | URL,
  cause?: unknown,
): Error {
  const seconds = Math.round(timeoutMs / 1000);
  debugLog('provider:stall', {
    phase: info.phase,
    timeoutMs,
    producedOutput: info.producedOutput,
    url: safeTarget(input),
  });
  const detail =
    info.phase === 'headers'
      ? `no response headers within ${seconds}s. The connection was accepted but never answered.`
      : `no data on the response body for ${seconds}s. The connection was accepted and then went quiet.`;
  const err = new Error(
    `Provider ${STALL_MARKER} — ${detail} Retry, or switch provider/lineup if it persists.`,
    cause === undefined ? undefined : { cause },
  );
  return markProviderStall(err, info);
}

/**
 * Re-wraps `res` so its body is watched for inactivity.
 *
 * Two details are load-bearing. The controller is errored with our own branded
 * error BEFORE the socket is torn down, so the consumer sees a stall rather
 * than racing us to a bare `AbortError` from the aborted fetch. And
 * `producedOutput` reports whether any chunk arrived — conservatively, since a
 * chunk that reached the SDK may already have become a `text-delta` on the
 * user's screen, and `OutputSink` has no reset. Erring that way costs at most a
 * retry we declined to attempt; erring the other way duplicates text mid-answer.
 */
function guardResponseBody(
  res: Response,
  idleMs: number,
  abortSocket: () => void,
  input: RequestInfo | URL,
): Response {
  const body = res.body;
  if (!body) return res;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let chunks = 0;
  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = (ctl: TransformStreamDefaultController<Uint8Array>): void => {
    clear();
    timer = setTimeout(() => {
      const err = stallError({ phase: 'body', producedOutput: chunks > 0 }, idleMs, input);
      try {
        ctl.error(err);
      } catch {
        // Already errored or closed — the consumer has its answer either way.
      }
      abortSocket();
    }, idleMs);
    // `unref` is what makes the consumer-cancel path safe to leave alone. There
    // is no `cancel` hook on `Transformer` in this TS lib, so a reader that
    // walks away leaves one armed timer behind; unref'd it cannot keep the
    // process alive, and when it fires `ctl.error` throws into the catch above
    // while `abortSocket` aborts a request that already finished. Harmless
    // both ways — which is why this is a comment and not a second mechanism.
    timer.unref?.();
  };

  const ts = new TransformStream<Uint8Array, Uint8Array>({
    start: (ctl) => arm(ctl),
    transform: (chunk, ctl) => {
      chunks += 1;
      arm(ctl);
      ctl.enqueue(chunk);
    },
    flush: clear,
  });

  // Headers must be carried across explicitly: a `Response` built from a new
  // body keeps none of the original's metadata, and the AI SDK reads
  // `content-type` to pick its SSE parser.
  return new Response(body.pipeThrough(ts), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
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
  getBodyIdleMs: () => number = resolveBodyIdleTimeoutMs,
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
    // Before the off-switch below: this wrapper is the only always-installed
    // layer under the SDK's retry loop, so disabling the stall guard must not
    // also disable request accounting (#308).
    countProviderRequest();
    // Both budgets are capped by any active `withStallBudget` override, and
    // both keep their own off switch: the guard steps aside only when BOTH are
    // disabled, since either one alone is still worth having.
    const headerMs = shorten(getTimeoutMs());
    const bodyIdleMs = shorten(getBodyIdleMs());
    if (headerMs <= 0 && bodyIdleMs <= 0) return fetchImpl(input, init);

    const caller = init?.signal ?? undefined;
    // Our OWN controller, not `AbortSignal.timeout`. The timeout signal used to
    // be passed straight in as `init.signal`, and that is the bug this replaces:
    // a signal handed to `fetch` stays bound for the whole response lifetime, so
    // the first-byte timer kept running and killed the BODY at 90 s. Owning the
    // controller lets the timer be cleared the moment headers land (see the
    // `finally`) while the socket stays abortable for the body's lifetime.
    //
    // `AbortSignal.any` still composes the caller's signal in, and that part is
    // not incidental: it is what keeps Esc reaching the socket mid-body. Since
    // ours aborts with a plain `AbortError` rather than a `TimeoutError`, the
    // "was this mine or theirs?" discrimination the runtime used to do is now
    // the `headerTimedOut` flag.
    const ours = new AbortController();
    const signal = caller ? AbortSignal.any([caller, ours.signal]) : ours.signal;

    let headerTimedOut = false;
    let headerTimer: ReturnType<typeof setTimeout> | null = null;
    if (headerMs > 0) {
      headerTimer = setTimeout(() => {
        headerTimedOut = true;
        ours.abort();
      }, headerMs);
      headerTimer.unref?.();
    }

    let res: Response;
    try {
      res = await fetchImpl(input, { ...init, signal });
    } catch (err) {
      if (headerTimedOut && !caller?.aborted) {
        throw stallError({ phase: 'headers', producedOutput: false }, headerMs, input, err);
      }
      throw err;
    } finally {
      // THE FIX, in one line. Without it this timer outlives the header await
      // and becomes a hard deadline on the body — which is precisely how a
      // reasoning step generating for 85 s came within 4.5 s of being killed,
      // and how a stalled body surfaced as a raw `TimeoutError` from a `catch`
      // that had already been skipped.
      if (headerTimer) clearTimeout(headerTimer);
    }

    // Only successful responses get a body guard. An error body is small and
    // read immediately by the SDK's own error path, so watching it adds a
    // failure mode and protects nothing.
    if (bodyIdleMs <= 0 || !res.ok) return res;
    return guardResponseBody(res, bodyIdleMs, () => ours.abort(), input);
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
