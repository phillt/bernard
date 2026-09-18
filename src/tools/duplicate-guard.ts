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
 * ## Eligibility is `ToolMeta.nonIdempotent`, and this is the second attempt
 *
 * The first cut of this module keyed on `shouldBlockInReadOnly` and was
 * withdrawn for it. That predicate answers MUTATION where this needs
 * IDEMPOTENCY, and measured against the real corpus the substitution is not
 * close: of 46 adjacent identical `shell` repeats it calls **44** of them
 * writes, including `ls -l … | cat` and `grep -nE …`, because
 * `primaryShellCommand` returns null for any compound line. So it fired ~44
 * times on that corpus to catch 2 duplicate sends. `risk.ts` now carries a
 * standing refusal to be asked this question.
 *
 * Repetition alone is the wrong signal too: **138 of 187** adjacent identical
 * calls in the corpus are reads — `shell` re-running a test, `file_read_lines`
 * after an edit, a browser snapshot polling for change. All correct.
 *
 * So the tool declares it. `mcp.ts` sets the flag from `hasEmitVerb`, which is
 * the whole live population — and that rule is narrower than "every MCP write"
 * on evidence rather than on caution: `focus_app` carries neither a read nor a
 * write verb, so it classifies as a write, and the dispatch that double-sent
 * called it TWICE with identical arguments, once before each send. MCP's own
 * `idempotentHint` is the right source and is unread today (#570).
 *
 * ## Scope: the turn, with the window as a backstop
 *
 * Not per-dispatch — that is what would have missed the case. The repeated send
 * came from a NEW delegate dispatch raised after the previous one had already
 * reported success, so a per-dispatch memory sees a first call every time and
 * passes all of them.
 *
 * Not session-wide either, which the first cut was: a cron daemon and the applet
 * host run many jobs in one process, and a job sending the same digest every
 * minute was refused on its second run with nobody watching. {@link
 * clearDuplicateGuard} is called at each turn boundary, so a repeat is only ever
 * compared against calls from the same piece of work.
 *
 * **Both halves are required; neither is sufficient** — the `rag.ts`
 * `persistState` rule. The window bounds the damage if a clear site is ever
 * missed, because the failure mode without it is a long-lived process refusing
 * forever, which fails closed in the wrong direction.
 */
import { sha256Hex } from '../hash.js';

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

/** Key → when the identical call last SUCCEEDED. */
const seen = new Map<string, number>();

/**
 * Composite key for one exact call: the tool, and a digest of ALL its arguments.
 *
 * **Hashed, and the whole string, because both halves were wrong at once.** The
 * first cut keyed on `augment.ts`'s `safeSerialize`, which slices to 300
 * characters — so two genuinely different calls sharing a 300-character prefix
 * collided and the second was refused as a duplicate. A `file_write` to one path
 * with different content, or two long messages to one chat differing only after
 * character 300, are both ordinary. That is a false refusal on a write, which is
 * the failure this module is otherwise written to avoid.
 *
 * Keying on the untruncated string instead would fix the collision and hold the
 * payload for the whole window — five megabytes of a file body, or an unredacted
 * `shell` credential, resident for five minutes in a module map. A digest fixes
 * both: 64 characters, and it retains nothing. Measured, it also COSTS nothing
 * next to what it replaced — sha256 is 18-25% of one `JSON.stringify` of the
 * same value (2.4 ms against 13.2 ms at 5 MB), and this change removes an entire
 * duplicate serialization from the call path.
 *
 * Deliberately NOT `result-cache.ts`'s `cacheKey`, which redacts through
 * `meta.sensitiveArgs` before keying. Redaction is right for a value cache and
 * wrong here: it MAKES collisions, and two calls differing only in a redacted
 * field are exactly the pair that must stay distinguishable. A hash needs no
 * redaction because it discloses nothing.
 *
 * The separator is `\\0` written as an ESCAPE, never as a literal control
 * character — it cannot occur in a tool name or in a hex digest, but typed raw
 * it is invisible in an editor and sails through prettier and eslint unnoticed.
 * One shipped that way here and was caught only because a mutation anchor failed
 * to match.
 */
/**
 * The identity of one call, hashed ONCE per call.
 *
 * Exported and taken as a parameter below rather than derived inside each
 * entry point, because the two entry points run on the same call in sequence
 * — refuse-or-not, then record-on-success — and each hashing `argsJson`
 * independently pays twice. Measured: ~1.6 µs for a typical MCP send, and
 * **2.1 ms for a 2 MB attachment** — and `upload` is in `EMIT_VERBS`, so
 * attachment-carrying tools are squarely in the gated population. It is
 * resolved in `runUnconditionalGates` beside `isWrite` / `nonIdempotent` /
 * `argsJson`, which that file already does for exactly this reason.
 *
 * `sha256Hex` rather than a local `createHash`: `hash.ts` is the `node:crypto`
 * leaf whose docstring asks for the fourth caller to come here, and it passes
 * an explicit `'utf-8'` this copy omitted.
 */
export function duplicateKeyFor(toolName: string, argsJson: string): string {
  return `${toolName}\0${sha256Hex(argsJson)}`;
}

/** Drops entries past the window so a long session does not grow without bound. */
function sweep(now: number): void {
  for (const [k, at] of seen) {
    if (now - at > DUPLICATE_WINDOW_MS) seen.delete(k);
  }
}

/**
 * The refusal a repeated write gets, or `null` to proceed.
 *
 * **Refusing forgets**, which is what makes re-issuing the confirmation: the
 * call immediately after a refusal finds no entry and proceeds, and its own
 * success then re-arms the gate through `recordSucceededCall`. A `warned` flag
 * on the entry expressed the same three states — traced through expiry,
 * failure, differing args and a third call, the two forms are identical — so
 * it was an interface, a mutable field and a branch for no behaviour.
 *
 * The one thing lost with it is a `confirmed` debug line, and that is
 * recoverable from the log rather than gone: a `tool:duplicate-refused`
 * followed by a `tool:execute:start` for the same tool IS a confirmation, and
 * one with no start after it is a duplicate this actually stopped.
 */
export function duplicateRefusal(
  toolName: string,
  key: string,
  now: number = Date.now(),
): string | null {
  const succeededAt = seen.get(key);
  if (succeededAt === undefined) return null;
  // Forgotten either way — the difference is only whether the model is told.
  seen.delete(key);
  if (now - succeededAt > DUPLICATE_WINDOW_MS) return null;
  const ago = Math.max(1, Math.round((now - succeededAt) / 1000));
  debugLog('tool:duplicate-refused', { tool: toolName, agoSeconds: ago });
  // Names the succeeded/again pair explicitly. "An identical call was made"
  // would tell a model that believes the first one failed nothing it does not
  // already think it knows.
  //
  // It no longer claims "its result is unchanged", which the withdrawal caught
  // as false after an edit — and which would be the one sentence a model acts
  // on. What replaces it is the observed reasoning verbatim: the helper that
  // re-sent recorded "deeplink returned, no delivery confirmation", so the
  // sentence that matters is that no confirmation is not the same as failure.
  return (
    `This exact call already SUCCEEDED ${ago}s ago and its effect has already happened. ` +
    `If the earlier call looked like it failed, it did not — its result carried no ` +
    `confirmation, which is not the same thing. ` +
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
export function recordSucceededCall(key: string, now: number = Date.now()): void {
  sweep(now);
  seen.set(key, now);
}

/**
 * Forgets every recorded call. Called at each turn boundary.
 *
 * A production clear, unlike the test-only seam this replaces, and that is the
 * fix for the half of the withdrawal that was about scope rather than
 * eligibility: session-wide state gave a cron daemon and the applet host
 * alternating refusals on identical scheduled writes, unattended.
 *
 * Every call site is a place where one piece of work ends and the next begins —
 * `runAgentTurn`, a headless run, an applet tool action. A site someone forgets
 * degrades to the window rather than to permanent refusal, which is why both
 * exist.
 */
export function clearDuplicateGuard(): void {
  seen.clear();
}
