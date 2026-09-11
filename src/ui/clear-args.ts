import stringWidth from 'string-width';
import { plural } from '../text.js';
import { cell } from './overlays/table.js';

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
  /**
   * The user pressed Esc while the extraction was running.
   *
   * Distinct from `failed` because it is not a failure: they stopped waiting,
   * and reporting their own keystroke back to them as an error message is how a
   * deliberate action reads as a fault. The clear itself still happens — that is
   * what was asked for — so this says what did NOT.
   */
  | { kind: 'cancelled' }
  /**
   * `kept` is the ONLY count. An earlier shape carried `facts` beside it — the
   * summed `addFacts` return — and the two can disagree: if one domain rejects
   * after storing some facts, `Promise.allSettled` drops its return value while
   * the observer's pushes survive, so the headline said "saved 2" above rows
   * summing to 3. The pushes are the truth, on a type whose whole purpose is to
   * say what actually happened.
   */
  | {
      kind: 'saved';
      kept: SavedFact[];
      /**
       * Domains whose `addFacts` rejected.
       *
       * On the outcome rather than in a toast: a toast is cleared by the next
       * submit, and "some of what you just saved was lost" is precisely the
       * thing this type exists to make durable. A partial failure was otherwise
       * recorded in the transcript as an unqualified success.
       */
      failed?: number;
    };

/** One fact that survived dedup, with the domain it was filed under. */
export interface SavedFact {
  domain: string;
  fact: string;
}

/** Below this there is no room for a fact worth reading, so the row drops to its label. */
const FACT_MIN = 24;

/**
 * How many terminal columns `s` occupies — not how many UTF-16 code units it is.
 *
 * The two are the same only for the Latin-1 subset, and the facts in a receipt
 * come from the user's own conversation. Measured on this branch at a 73-column
 * budget, one ordinary Japanese fact measured 51 by `String.length` and occupied
 * **87** columns: it passed the fit check, wrapped, and its tail rendered as a
 * row that does not exist — the exact failure the docstring on
 * {@link receiptLines} says the measurement prevents. Anyone working in Chinese,
 * Japanese or Korean hit it on their first `/clear`, at any width. Combining
 * marks under-count the same way East Asian characters over-count.
 *
 * `string-width` rather than a local table: this is a Unicode data problem, the
 * tables move every Unicode release, and the repo already ships the package —
 * it is what Ink itself measures with. Promoted to a direct dependency at the
 * same time, since relying on a transitive hoist is how this silently becomes a
 * resolution error later.
 */
const widthOf = (s: string): number => stringWidth(s);

/**
 * `s` cut to at most `cols` display columns, with `…` marking the cut.
 *
 * Deliberately not `text.ts`'s {@link truncate}, which counts and slices code
 * units — that is right for a byte budget and wrong for a column one, and its
 * `slice` can also land between a surrogate pair and leave half a character
 * behind. This walks code POINTS, so a cut never splits one.
 */
function fitToWidth(s: string, cols: number): string {
  if (cols <= 0) return '';
  if (widthOf(s) <= cols) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const w = widthOf(ch);
    // `…` is one column, and it is going on the end.
    if (used + w > cols - 1) break;
    out += ch;
    used += w;
  }
  return out.trimEnd() + '…';
}

/**
 * The per-domain receipt: what Bernard actually took away from the conversation.
 *
 * A count alone answers "did it work" and nothing else, and the whole reason
 * `/clear` needed a result line was that its outcome was unknowable. Someone who
 * has just spent ten seconds on two model calls should be able to see what they
 * bought — and, more usefully, correct it: a wrong fact is far easier to notice
 * here than in `/memory` three sessions later.
 *
 * **Only facts that survived dedup are listed**, which is why the text comes from
 * inside `addFacts` through its observer rather than from the extraction.
 * Listing an extracted fact that turned out to be a duplicate would claim a save
 * that did not happen, on the one surface built to stop exactly that.
 *
 * One line per DOMAIN, not per fact, and that is what keeps it a receipt rather
 * than a second `/memory`. The domain registry is closed — four of them — so the
 * height is bounded by construction with no "…and N more" to maintain, and the
 * count carries what the elision would have said.
 *
 * **Padded with `cell`, not `padEnd`.** The reason originally given for that —
 * that a label longer than the column would pad to nothing and push its own fact
 * out of alignment — cannot happen here: `labelWidth` is the maximum over the
 * very labels being padded, so `cell`'s truncation branch is unreachable and the
 * call is exactly `padEnd`. The real reason is that it is the house primitive for
 * this and costs nothing, and that the hazard becomes reachable the moment anyone
 * clamps `labelWidth` to a maximum. Stated correctly because the previous version
 * presented a guarantee as load-bearing when it was true by accident.
 *
 * Labels are the one part measured in code units rather than columns, and that is
 * safe rather than overlooked: a label is `<domain> (<count>)`, and the domain
 * registry is a closed ASCII set. The fact text is not, which is what
 * {@link fitToWidth} is for.
 *
 * The alignment survives rendering because `renderMarkdown` sets
 * `reflowText: false` — Ink owns wrapping, so marked-terminal leaves the lines
 * exactly as written. That is also why every row must be measured to fit:
 * nothing downstream will shorten one, it will simply wrap and its tail will read
 * as another row.
 *
 * **Known limit: the fit holds only at the width it was pushed at.** Nothing
 * downstream re-measures either. (The other half of this used to be
 * `markdownBodyWidth`'s `Math.max(40, …)` floor, which over-reported below 47
 * columns and made every row wrap at push time with no resize involved. The
 * caller passes `floor: false` now, so what remains really is only the resize
 * case.) `pushTranscriptMessage` stores an immutable
 * string in `staticItems`, so unlike every other width-aware surface here — which
 * re-derive at render, `SourcesViewer` from `innerWidth` in a `useMemo`,
 * `MarkdownLines` from `useDimensionsCtx` — this one is frozen. Measured: baked at
 * 120 columns and rendered at 100, two rows wrap and their tails read as extra
 * rows, which is exactly what the row-width test prevents at push time and cannot
 * prevent at render time.
 *
 * Left as a recorded limit rather than fixed, because the fix is a structured
 * `StaticItem` variant and `StaticItemView` exists precisely because there are TWO
 * transcript surfaces — "a variant added to one is broken for half the users and
 * invisible to whoever wrote it" — plus `pushTranscriptMessage`'s one-writer
 * invariant. That is a large change against two cosmetic phantom rows, on one
 * notice, after a resize. If a structured item ever lands for another reason, the
 * receipt should move to it.
 */
function receiptLines(kept: readonly SavedFact[], width: number): string[] {
  const byDomain = new Map<string, string[]>();
  for (const k of kept) {
    const list = byDomain.get(k.domain);
    if (list) list.push(k.fact);
    else byDomain.set(k.domain, [k.fact]);
  }

  const rows = Array.from(byDomain, ([domain, facts]) => ({
    label: `${domain} (${facts.length})`,
    fact: facts[0].replace(/\s+/g, ' ').trim(),
  }));
  const labelWidth = rows.reduce((w, r) => Math.max(w, r.label.length), 0);

  // Two-space indent, not four: four would make markdown treat these as a code
  // block. The gap is two spaces for the same reason `preview-lines` uses a
  // literal there — it is the column, not a knob.
  const factWidth = width - 2 - labelWidth - 2;
  return rows.map((r) =>
    factWidth < FACT_MIN
      ? // The label row is fitted too. At a very narrow width the labels alone
        // can outrun the budget, and an unfitted fallback would wrap exactly like
        // the row it is the fallback for.
        `  ${fitToWidth(r.label, width - 2)}`
      : `  ${cell(r.label, labelWidth)}  ${fitToWidth(r.fact, factWidth)}`,
  );
}

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
    case 'cancelled':
      return 'Cleared. Saving was cancelled.';
    case 'saved': {
      const n = outcome.kept.length;
      const lost = outcome.failed ?? 0;
      // Named on the headline rather than appended after the rows, so it is read
      // before the list it qualifies rather than after it.
      const caveat = lost > 0 ? ` (${lost} ${plural(lost, 'domain', 'domains')} failed)` : '';
      return n === 0
        ? `Cleared and saved — no new facts beyond what memory already held${caveat}.`
        : `Cleared and saved ${n} new ${plural(n, 'fact', 'facts')} to memory${caveat}:`;
    }
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
export function clearResultMessage(
  outcome: SaveOutcome,
  width: number,
  noteSaveIsDefault = false,
): string {
  // A blank line between the sentence and the table, so markdown keeps them as
  // separate paragraphs and the receipt reads as a block rather than a run-on.
  const rows =
    outcome.kind === 'saved' && outcome.kept.length > 0
      ? ['', ...receiptLines(outcome.kept, width)]
      : [];
  // The note goes on its own line whenever rows were emitted — appended, it rides
  // the last listed fact and reads as part of it. Decided from the fact that
  // produced the rows rather than by scanning the output for a newline.
  const body = [headline(outcome), ...rows].join('\n');
  if (!noteSaveIsDefault) return body;
  return rows.length > 0 ? `${body}\n${SAVE_IS_DEFAULT_NOTE}` : `${body} ${SAVE_IS_DEFAULT_NOTE}`;
}
