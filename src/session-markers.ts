/**
 * Synthetic messages Bernard injects into conversation history to mark a seam —
 * a compression boundary, an emergency truncation, a continuation prompt, or a
 * session restart. They are prompt scaffolding addressed to the model, not
 * things the user typed or the assistant chose to say.
 *
 * Every consumer that walks history for *conversation* has to skip them, and
 * each one that hand-rolled its own list drifted: the RAG query filter knew
 * four markers, the resume replay knew two, and `src/index.ts` spelled the
 * session-boundary pair out twice more. Reword a sentence in one place and the
 * others silently start leaking scaffolding into their output. This module owns
 * the strings so that can't happen.
 *
 * Note the asymmetry: the `[bracketed]` notices are `user`-role and are matched
 * by *prefix* (most interpolate a summary or task hint after the marker), while
 * the acknowledgements are `assistant`-role and are fixed, whole strings.
 */

/** User-role notice injected by `compressHistory` ahead of a context summary. */
export const CONTEXT_SUMMARY_PREFIX = '[Context Summary';
/** User-role notice injected by `emergencyTruncate` when history is dropped. */
export const TRUNCATION_PREFIX = '[Earlier conversation was truncated';
/** User-role notice injected by the auto-continue path on a cut-off response. */
export const CONTINUATION_PREFIX = '[Your previous response was cut off';
/** User-role notice injected by `--resume` to separate the restored session. */
export const SESSION_BOUNDARY_PREFIX = '[Previous session ended';

/**
 * Full text of the `--resume` session-boundary pair. `src/index.ts` injects
 * these verbatim and strips any prior copy before re-injecting, so both sides of
 * that round-trip must reference the same constants.
 */
export const SESSION_BOUNDARY_NOTICE = `${SESSION_BOUNDARY_PREFIX}. New session starting. Treat tasks from prior session as completed unless the user explicitly continues them.]`;
export const SESSION_BOUNDARY_ACK =
  "Understood. Starting a new session. I'll only reference prior context if relevant to your current request.";

/** Assistant acknowledgement paired with a context summary. */
export const CONTEXT_SUMMARY_ACK =
  "Understood. I have the context from our earlier conversation. Let's continue.";
/** Assistant acknowledgement paired with an emergency truncation notice. */
export const TRUNCATION_ACK = 'Understood. Continuing with limited context.';

/** Prefixes of every user-role scaffolding notice. */
export const BOUNDARY_PREFIXES = [
  CONTEXT_SUMMARY_PREFIX,
  SESSION_BOUNDARY_PREFIX,
  TRUNCATION_PREFIX,
  CONTINUATION_PREFIX,
];

/** Exact text of every assistant-role scaffolding acknowledgement. */
const BOUNDARY_ACKS = [SESSION_BOUNDARY_ACK, CONTEXT_SUMMARY_ACK, TRUNCATION_ACK];

/** True when `text` is a user-role scaffolding notice rather than a real turn. */
export function isBoundaryNotice(text: string): boolean {
  return BOUNDARY_PREFIXES.some((p) => text.startsWith(p));
}

/**
 * True when `text` is either half of an injected seam — the notice or its
 * acknowledgement. Use this when rendering history *as conversation* (the
 * resume replay); use {@link isBoundaryNotice} when only user turns are in
 * scope (the RAG query builder).
 */
export function isSessionScaffolding(text: string): boolean {
  return isBoundaryNotice(text) || BOUNDARY_ACKS.includes(text);
}
