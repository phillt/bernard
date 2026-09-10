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
 * that is {@link ClearPlan.noteSaveIsDefault} having something to be appended to:
 * a result line that says what actually happened.
 *
 * A pure leaf so the parse is tested without Ink or a React tree — `App.tsx`'s
 * `/clear` branch reaches a store, an agent, four persistence calls and a
 * terminal escape, none of which this decision depends on.
 */

export interface ClearPlan {
  /** Whether to extract facts before wiping the history. */
  save: boolean;
  /**
   * Whether to tell the user that `--save` is redundant.
   *
   * True only when they actually typed it — a note on every clear is noise, and a
   * note on `--do-not-save` would be actively wrong.
   */
  noteSaveIsDefault: boolean;
}

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
  if (arg === '') return { save: true, noteSaveIsDefault: false };
  if (SAVE_FLAGS.has(arg)) return { save: true, noteSaveIsDefault: true };
  if (NO_SAVE_FLAGS.has(arg)) return { save: false, noteSaveIsDefault: false };
  return null;
}

/** The note appended when the user typed a flag they no longer need. */
export const SAVE_IS_DEFAULT_NOTE =
  '/clear saves by default now — you can drop --save. Use --do-not-save to skip it.';

/** What the save actually did, for the line the user reads after the screen clears. */
export type SaveOutcome =
  | { kind: 'skipped' }
  | { kind: 'too-short' }
  | { kind: 'failed'; message: string }
  | { kind: 'saved'; facts: number };

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
  const head = (() => {
    switch (outcome.kind) {
      case 'skipped':
        return 'Cleared without saving.';
      case 'too-short':
        return 'Cleared. Too little conversation to save anything from.';
      case 'failed':
        return `Cleared, but saving failed: ${outcome.message}`;
      case 'saved':
        return outcome.facts === 0
          ? 'Cleared and saved — no new facts beyond what memory already held.'
          : `Cleared and saved ${outcome.facts} new fact${outcome.facts === 1 ? '' : 's'} to memory.`;
    }
  })();
  return noteSaveIsDefault ? `${head} ${SAVE_IS_DEFAULT_NOTE}` : head;
}
