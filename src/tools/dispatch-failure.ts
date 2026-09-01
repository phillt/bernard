import { isDispatchCancellation } from '../error-taxonomy.js';

/**
 * Runs a child dispatch, converting a *work failure* into whatever this tool's
 * own contract says a failure looks like, and letting a *cancellation* unwind
 * (#327, #351).
 *
 * Five boundaries call `runDefinition` on the model's behalf — `subagent`,
 * `specialist-run`, `delegate-dispatch`, `task`, `tool-wrapper-run` — and every
 * one of them hand-rolled the same two statements plus a four-line comment
 * duplicated verbatim at three of them. Only the third statement, the shaper,
 * genuinely differed. Two statements are worth extracting here because getting
 * either one wrong is silent and expensive:
 *
 * 1. **The re-throw.** A returned value is a *successful* tool result. That is
 *    right for a failed MCP call — the model reads it, works around it, and the
 *    turn continues — and wrong for a cancellation, which the parent then reads
 *    as data and keeps looping on: a user's Esc during a child dispatch used to
 *    arrive as `Sub-agent failed: Aborted` while the parent ran on until its own
 *    signal happened to trip. #327's first pass patched three of the five sites;
 *    the two it missed (`task`, `tool-wrapper-run`) both pass `abortSignal` too.
 *    An identical two-line paste missing 40% of its sites is the signature of a
 *    fix that wants to be one layer down — this is that layer.
 * 2. **The message extraction.** `err instanceof Error ? err.message : String(err)`
 *    is not interesting, but it is what every shaper interpolates, and a site
 *    that reached for `String(err)` alone would interpolate `[object Object]`
 *    into the string the model has to act on.
 *
 * Re-throwing is safe for the concurrency pool: `withSlot` / `withUncappedSlot`
 * (#317) release in a `finally`, so the unwind cannot strand a slot. The two
 * compose as `withSlot(() => runDispatchOrFail(work, shape), exhausted)` — slot
 * lifecycle outside, failure shaping inside — and they stay separate modules
 * because they answer different questions and `agent-pool.ts` is a leaf with
 * nothing but `node:async_hooks` behind it.
 *
 * **`onFailure` is a callback rather than a discriminated return** for exactly
 * the reason `withSlot`'s `onExhausted` is (#317): the five call sites report a
 * failure in shapes dictated by their own tool contracts, not by preference.
 * Three return a string whose `Error: ` prefix is load-bearing — it is what
 * `detectResultFailure` (`tool-result-shape.ts`) reads to see the failure at all
 * (#364), and without it the result registers as citable evidence and bumps the
 * tool's `successCount`; `task` must return a `ToolResult` envelope;
 * `tool-wrapper-run` a `WrapperResult` with an `error` label. Their wordings are
 * asserted verbatim by tests, which is what pins those shapes. A discriminated
 * return would have to enumerate four unrelated envelope types and each site
 * would unwrap it back into what it already had. They converge where it matters
 * anyway: `error-taxonomy.ts` classifies every one of them.
 *
 * `onFailure` receives the raw `err` beside the extracted message so a shaper
 * can reach for structured fields (`httpStatus`, `errno`) without this signature
 * having to widen later. No current site needs it; TypeScript lets a shaper
 * declare only the first parameter.
 *
 * Note this does NOT own the try scope. `delegate-dispatch` deliberately covers
 * its tool-registry assembly and its PAC self-escalation branch, not just the
 * `runDefinition` call — pass whatever region you mean to protect as `fn`.
 */
export async function runDispatchOrFail<T>(
  fn: () => Promise<T>,
  onFailure: (message: string, err: unknown) => T,
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (isDispatchCancellation(err)) throw err;
    return onFailure(err instanceof Error ? err.message : String(err), err);
  }
}
