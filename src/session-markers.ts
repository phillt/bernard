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
 * Note the asymmetry: the user-role notices are matched by *prefix* (most
 * interpolate a summary, a task hint or a rendered plan after the marker),
 * while the acknowledgements are `assistant`-role and are fixed, whole strings.
 * Most are `[bracketed]`; the plan-enforcement pair is not, because that text is
 * tuned prompt wording the model reads verbatim and bracketing it to match the
 * others would change what every coordinator turn is told.
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
 * User-role re-prompt from the plan-enforcement loop, asking the model to
 * resolve the steps it left pending.
 *
 * Unbracketed, unlike its neighbours, because the text is tuned prompt wording
 * that reaches the model verbatim — bracketing it to match would change what
 * every coordinator turn is told. `react.ts` interpolates this constant rather
 * than repeating the sentence, so the producer and this detector cannot drift.
 */
export const PLAN_ENFORCEMENT_PREFIX = 'Your plan still has unresolved steps:';
/** User-role re-prompt for a coordinator turn that never called `plan`. */
export const MISSING_PLAN_PREFIX = 'You are operating in coordinator mode but did not call';

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

/**
 * Opening line of a message the user typed while a turn was running (#200).
 *
 * **Not scaffolding, and deliberately absent from {@link BOUNDARY_PREFIXES}.**
 * The text after this line is the user's own words and must render as theirs,
 * feed the RAG query and survive resume like any other request. The line itself
 * is the part addressed to the model: it says the message arrived mid-work, so
 * the model reads it as a correction to the task in hand rather than a new one,
 * and it asks for the one thing a late correction owes the user — what can and
 * cannot still change, since some of the work may already be done.
 *
 * Every reader that shows or embeds the user's words strips it through
 * {@link stripInterjectionNotice}, so the sentence has one spelling.
 */
export const INTERJECTION_NOTICE =
  '[Sent while you were working. Take this into account from here on; if it conflicts with something you have already done, say what you can and cannot still change.]';

/** The model-facing form of a mid-turn message: the notice, then the user's words. */
export function renderInterjection(text: string): string {
  return `${INTERJECTION_NOTICE}\n${text}`;
}

/**
 * The user's words out of a mid-turn message, and whether it was one.
 * Expects the timestamp already removed — the notice follows it.
 */
export function stripInterjectionNotice(text: string): { body: string; interjected: boolean } {
  const head = `${INTERJECTION_NOTICE}\n`;
  return text.startsWith(head)
    ? { body: text.slice(head.length), interjected: true }
    : { body: text, interjected: false };
}

/** Prefixes of every user-role scaffolding notice. */
export const BOUNDARY_PREFIXES = [
  CONTEXT_SUMMARY_PREFIX,
  SESSION_BOUNDARY_PREFIX,
  TRUNCATION_PREFIX,
  CONTINUATION_PREFIX,
  PLAN_ENFORCEMENT_PREFIX,
  MISSING_PLAN_PREFIX,
];

/**
 * What the model is told when a turn is stopped (#403, #478).
 *
 * Lives here rather than in `agent.ts` because it is scaffolding by the same
 * definition as everything above — addressed to the model, not something the
 * assistant chose to say — and because the transcript has to skip it. On its
 * own it renders as an assistant bubble whose entire content is transcript
 * furniture, beside the `⏹ Turn interrupted` notice that already says the same
 * thing in the user's own channel.
 *
 * Only the BARE marker is scaffolding. `processInput`'s abort branch appends it
 * to whatever partial text the turn produced, and that text is real content the
 * user should still see — so this is matched as a whole string, never as a
 * suffix.
 */
export const INTERRUPTED_MARKER = '[interrupted by user]';

/**
 * Exact text of every assistant-role scaffolding message.
 *
 * Was `BOUNDARY_ACKS` while it held only the three acknowledgements. The
 * interrupt marker is not an acknowledgement of anything, so the old name
 * described three of its four entries — renamed rather than left to read as a
 * list someone could "tidy" the odd one out of.
 */
const ASSISTANT_SCAFFOLDING = [
  SESSION_BOUNDARY_ACK,
  CONTEXT_SUMMARY_ACK,
  TRUNCATION_ACK,
  INTERRUPTED_MARKER,
];

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
  return isBoundaryNotice(text) || ASSISTANT_SCAFFOLDING.includes(text);
}
