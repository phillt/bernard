/**
 * Always-on count of HTTP requests actually issued to a model provider (#308).
 *
 * ## Why this exists
 *
 * xAI's usage export billed **87 requests** for a 15-minute window in which
 * Bernard recorded **22 LLM calls** and logged **24** `http:request:start`
 * events. Tokens reconciled with the provider to 0.22%; request counts were off
 * by ~3.6x. Something is issuing requests that never mint a telemetry record —
 * candidates being SDK-level retries (nothing in `src/` sets `maxRetries`, so
 * every `generateText` runs the AI SDK default of 2 retries → up to 3 attempts
 * per call), failed or aborted calls that never reach `onStepFinish`
 * (`recordStep` deliberately skips steps with no usage payload), or provider-side
 * metering counting something other than what we call a request.
 *
 * If those are retries, they cost real money and are currently invisible.
 *
 * ## Why not reuse the existing instrumentation
 *
 * `installInstrumentedFetchIfDebug()` is gated on `BERNARD_DEBUG`, so it can
 * only observe a session someone already suspected. A counter that answers "did
 * this session issue more requests than it recorded calls?" has to be running
 * during the session that surprises you — which means always on. It is a single
 * integer increment per request, so "always on" costs nothing.
 *
 * ## Privacy
 *
 * Counts only. No URL, host, method, status, header, or body ever enters this
 * module — the instrumented-fetch privacy contract applies here too, and a bare
 * counter cannot violate it.
 *
 * Process-global, like the counter in `agent-pool.ts`: one Bernard process is
 * one session, and the provider clients that call this are constructed per
 * request with no session handle to thread through.
 */

let attempts = 0;

/**
 * Record one outbound provider request. Called from the stall-guard fetch
 * wrapper, which is injected into every built-in and custom client and wraps
 * every completion — including when the stall guard itself is disabled.
 */
export function countProviderRequest(): void {
  attempts++;
}

/**
 * Requests issued to model providers so far this process.
 *
 * Compare against the session's telemetry record count: a material excess is
 * retry (or failed-call) spend that the per-call accounting cannot see.
 */
export function getProviderRequestCount(): number {
  return attempts;
}

/** Test-only hook so counts don't leak between cases. */
export function _resetProviderRequestCountForTests(): void {
  attempts = 0;
}
