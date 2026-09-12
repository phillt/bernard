/**
 * @module tools/duplicate-guard
 *
 * A write that already succeeded is not repeated silently.
 *
 * ## The defect the write barrier does not reach
 *
 * `write-barrier.ts` fixes a verification read that raced the write it was
 * checking. That is one of two shapes, and measured across 81 session logs it is
 * the SMALLER one — of the identical write pairs, **45** had a read between them
 * (the barrier's population) and **58** had no read at all.
 *
 * The Dom incident is the second shape:
 *
 * ```
 * 21:18:02.647  send_message  → "**Open the chat in Beeper**: /open/29"
 * 21:18:04.568  focus_app
 * 21:18:06.357  send_message  ← again, byte-identical. No read anywhere between.
 * ```
 *
 * There was no stale verification because there was no verification. The result
 * says nothing about whether anything happened — no message id, no success
 * field — so the model re-sent blind. Ordering cannot help: the second call was
 * never checking the first.
 *
 * ## Why the message says SUCCEEDED and not "you already called this"
 *
 * This is the half that decides whether the gate works at all. A model that
 * re-issues is one that believes the first call failed; telling it "an identical
 * call was made" confirms what it already thinks and it retries anyway. The
 * load-bearing content is that the earlier call **returned successfully**, which
 * is the fact it was missing and could not get from the result.
 *
 * So only a SUCCESS is recorded. A failed write that is retried is the retry
 * working as intended and must never be gated — that would turn a transient
 * failure into a permanent one.
 *
 * ## Why it refuses rather than prompts
 *
 * Returned as a tool result, so it works where there is nobody to ask: cron,
 * `bernard script`, applet actions. Re-issuing IS the confirmation — the model
 * says "yes, again" by doing it, which costs one round trip and no UI.
 *
 * ## Scope, and why per-dispatch would have missed the case that motivated it
 *
 * Session-scoped. The third Dom send came from a NEW delegate dispatch, raised
 * after the previous one had already reported success — so a per-dispatch memory
 * would have seen a first call each time and passed all three.
 *
 * ## Writes only, and why that is the whole rule for now
 *
 * Repetition alone is the wrong signal: **138 of 187** adjacent identical calls
 * in the corpus are reads — `shell` re-running a test, `file_read_lines` after
 * an edit, a browser snapshot polling for change. All correct, all would prompt.
 *
 * Among WRITES, though, every identical repeat observed is unwanted: duplicate
 * sends, duplicate `calendar_create_event`, and a `calendar_update_event` loop
 * that re-applied the same body six times at ~1.8 s intervals. Idempotency would
 * make the calendar case provably harmless rather than merely wasteful, and MCP
 * exposes `idempotentHint` for exactly this — but it is unread today (#570), so
 * declaring the field now would be a lie on disk. Gating every repeated write is
 * the conservative reading, and the cost of being wrong is one round trip.
 */
import { debugLog } from '../logger.js';

/**
 * How long a success keeps guarding.
 *
 * Measured over 103 repeated-write pairs: 96 fall within 30 s, 98 within 60 s,
 * **102 within 300 s**, and the one straggler is 93 minutes — far enough apart
 * to be a separate decision rather than a retry. The window is generous on
 * purpose, because the costs are asymmetric: a false fire costs one round trip,
 * a miss costs a duplicate side effect somebody receives.
 */
export const DUPLICATE_WINDOW_MS = 300_000;

interface Entry {
  /** When the identical call last SUCCEEDED. */
  succeededAt: number;
  /** Whether the model has already been told, and so may now proceed. */
  warned: boolean;
}

const seen = new Map<string, Entry>();

/**
 * Composite key for one exact call.
 *
 * The separator is `\\0` written as an ESCAPE, never as a literal control
 * character. It is the right separator — it cannot occur in a tool name or in
 * `JSON.stringify` output, so no two distinct calls can collide on it — but
 * typed raw it is invisible in an editor and sails through prettier and eslint
 * unnoticed. There is already one literal NUL in the tree, at `inbox/send.ts`'s
 * `dedupeKey`, for the same reason; this one is at least readable.
 */
function keyOf(toolName: string, argsJson: string): string {
  return `${toolName}\0${argsJson}`;
}

/** Drops entries past the window so a long session does not grow without bound. */
function sweep(now: number): void {
  for (const [k, e] of seen) {
    if (now - e.succeededAt > DUPLICATE_WINDOW_MS) seen.delete(k);
  }
}

/**
 * The refusal a repeated write gets, or `null` to proceed.
 *
 * Consumes the warning: the call immediately after a refusal proceeds, which is
 * what makes re-issuing the confirmation. It also clears the record, so the
 * confirmed call starts a fresh window rather than being gated again by the
 * original success.
 */
export function duplicateWriteRefusal(
  toolName: string,
  argsJson: string,
  now: number = Date.now(),
): string | null {
  const key = keyOf(toolName, argsJson);
  const entry = seen.get(key);
  if (!entry) return null;
  if (now - entry.succeededAt > DUPLICATE_WINDOW_MS) {
    seen.delete(key);
    return null;
  }
  if (entry.warned) {
    // Confirmed. Forget it entirely rather than re-arming, or the NEXT
    // identical call would be refused on the strength of a success the model
    // has already been told about and deliberately repeated.
    seen.delete(key);
    debugLog('tool:duplicate-write:confirmed', { tool: toolName });
    return null;
  }
  entry.warned = true;
  const ago = Math.max(1, Math.round((now - entry.succeededAt) / 1000));
  debugLog('tool:duplicate-write:refused', { tool: toolName, agoSeconds: ago });
  // Names the succeeded/again pair explicitly. "An identical call was made"
  // would tell a model that believes the first one failed nothing it does not
  // already think it knows.
  return (
    `This exact call already SUCCEEDED ${ago}s ago, and its result is unchanged. ` +
    `If the earlier call looked like it failed, it did not — check before repeating it. ` +
    `To do it a second time on purpose, make the identical call again and it will run.`
  );
}

/**
 * Records that a write succeeded, so an identical repeat is caught.
 *
 * Only successes: see the module docstring. Called after the result has been
 * classified, so `augment.ts`'s own failure detection — which reads MCP's
 * `isError`, the `{error}` shape and the `Error:` prefix — is the one authority
 * on what "succeeded" means here rather than a second guess at it.
 */
export function recordWriteSuccess(
  toolName: string,
  argsJson: string,
  now: number = Date.now(),
): void {
  sweep(now);
  seen.set(keyOf(toolName, argsJson), { succeededAt: now, warned: false });
}

/** Test seam: no production caller, and none should exist. */
export function __resetDuplicateGuard(): void {
  seen.clear();
}
