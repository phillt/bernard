import { plural } from '../text.js';

/**
 * @module clear-args
 *
 * What `/clear`'s arguments mean (#250).
 *
 * **Saving is the default now**, which inverts the flag: `--save` used to be how
 * you opted in, and is now a no-op kept for the muscle memory of everyone who
 * typed it for months. The motivating report is worth recording, because it is
 * not the default that caused it — it is the silence. `/clear --save` and
 * `/clear` both ended in the same toast, `Conversation history cleared.`, so
 * there was no way to tell a save from a no-save from a failed save. The fix for
 * that is a result line which says what actually happened, for the note to be
 * appended to.
 *
 * `plural` comes from `text.ts`, which has no imports either — the idiom this
 * file would otherwise have been the fifteenth place to hand-roll.
 *
 * A pure leaf so the parse is tested without Ink or a React tree — `App.tsx`'s
 * `/clear` branch reaches a store, an agent, four persistence calls and a
 * terminal escape, none of which this decision depends on.
 */

/**
 * The three things `/clear` can be asked to do.
 *
 * A union rather than `{save, noteSaveIsDefault}`, because those two booleans
 * admit `{save: false, noteSaveIsDefault: true}` — telling the user "saving is
 * the default" on the flag that turns saving OFF. A docstring had to explain that
 * the state was meaningless and a test had to assert it never occurred; the union
 * makes both unnecessary.
 */
export type ClearPlan = 'save' | 'save-noting-default' | 'skip';

/** What to print when the arguments do not parse. Names every accepted spelling. */
export const CLEAR_USAGE = 'Usage: /clear [--save | --do-not-save]';

/**
 * `--no-save` is accepted beside `--do-not-save`.
 *
 * #250 names only the long form, and that stays the one in `CLEAR_USAGE` and in
 * `/help`. The alias is here because `--no-save` is the conventional spelling for
 * this in every other CLI, and the cost of rejecting it is that the one command
 * whose whole purpose is "do not lose my work" answers a near-miss with a usage
 * error. `-s` has the same history on the other side.
 */
const SAVE_FLAGS = new Set(['--save', '-s']);
const NO_SAVE_FLAGS = new Set(['--do-not-save', '--no-save']);

/**
 * Parses the text after `/clear`.
 *
 * `null` means the arguments are not understood, which the caller reports with
 * {@link CLEAR_USAGE} — deliberately not "fall back to the default", because the
 * default now WRITES, and a typo'd flag silently running the expensive path is
 * the wrong direction to fail in.
 */
export function parseClearArgs(args: string): ClearPlan | null {
  const arg = args.trim();
  if (arg === '') return 'save';
  if (SAVE_FLAGS.has(arg)) return 'save-noting-default';
  if (NO_SAVE_FLAGS.has(arg)) return 'skip';
  return null;
}

/** The note appended when the user typed a flag they no longer need. */
export const SAVE_IS_DEFAULT_NOTE =
  '/clear saves by default now — you can drop --save. Use --do-not-save to skip it.';

/** What the save actually did, for the line the user reads after the screen clears. */
export type SaveOutcome =
  | { kind: 'skipped' }
  | { kind: 'too-short' }
  /**
   * RAG is off, so there is nowhere for extracted facts to land.
   *
   * Measured before this existed: the two extraction calls ran anyway and every
   * fact was dropped on the floor — ~10 s of blocked REPL and ~98,000 input
   * tokens per clear, paid by whoever had turned long-term memory off. Opting in
   * with `--save` used to be the only way to reach that; saving by default made
   * it the common path.
   */
  | { kind: 'no-memory' }
  | { kind: 'failed'; message: string }
  | { kind: 'saved'; facts: number };

/** The sentence for one outcome. Exhaustive, so a sixth variant is a compile error. */
function headline(outcome: SaveOutcome): string {
  switch (outcome.kind) {
    case 'skipped':
      return 'Cleared without saving.';
    case 'too-short':
      return 'Cleared. Too little conversation to save anything from.';
    case 'no-memory':
      return 'Cleared. Nothing was saved — long-term memory is off (BERNARD_RAG_ENABLED).';
    case 'failed':
      return `Cleared, but saving failed: ${outcome.message}`;
    case 'saved':
      return outcome.facts === 0
        ? 'Cleared and saved — no new facts beyond what memory already held.'
        : `Cleared and saved ${outcome.facts} new ${plural(outcome.facts, 'fact', 'facts')} to memory.`;
  }
}

/**
 * The one line the user gets after a clear.
 *
 * It replaces a toast that said `Conversation history cleared.` on every path,
 * including the ones that saved nothing and the ones that threw — which is what
 * made "did it actually save?" unanswerable without reading the RAG store. Each
 * outcome reads differently, and `saved: 0` is its own sentence rather than a
 * zero in a count: `addFacts` returns what survived dedup, so nothing new is the
 * ordinary result of clearing twice about the same subject, not a failure.
 */
export function clearResultMessage(outcome: SaveOutcome, noteSaveIsDefault = false): string {
  const head = headline(outcome);
  return noteSaveIsDefault ? `${head} ${SAVE_IS_DEFAULT_NOTE}` : head;
}
