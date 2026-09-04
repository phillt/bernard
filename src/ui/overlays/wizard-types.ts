import { truncate } from '../../text.js';
import type { AskUserQuestion } from '../../tools/types.js';

/**
 * A step-by-step wizard: shapes and pure state transitions (#473).
 *
 * No React, no Ink — `WizardOverlay.tsx` renders this and nothing else decides
 * what a key press means. Split for the reason `list-nav.ts` and
 * `menu-geometry.ts` are: the interesting behaviour is the state machine, and a
 * state machine tested through a terminal renderer is tested badly.
 *
 * ## Why the component owns the whole batch
 *
 * Every existing overlay result is two-state — `{cancelled: true}` or a value —
 * and there is no "go back" outcome anywhere in the repo. Adding one to
 * `requestMenu` would change every call site that treats `cancelled` as "abort
 * the flow". Owning the batch sidesteps that: back is internal state, and the
 * promise still resolves exactly once, with everything or with a cancellation.
 *
 * That is also what makes the review screen possible. `runProfileWizardInk`
 * sequences `await requestMenu(...)` per field, so each step is a full
 * unmount/remount with no memory of the last — it cannot offer "change your
 * answer to question 2" because question 2's overlay is gone.
 *
 * ## What is deliberately NOT here
 *
 * **No progress fraction**, and no "I don't know" row — see `WizardOverlay.tsx`,
 * which is the file that would render either.
 *
 * ## What it deliberately cannot express
 *
 * A FLAT batch of string answers with no validation. No branching (`steps` is a
 * frozen array), no typed answers (`WizardAnswer` is `string | string[]`), no
 * per-step validate hook. `runProfileWizardInk` needs all three — conditional
 * category steps, `int`/`float01`/`boolean` fields with range checks, and a
 * re-prompt on invalid — so it is not a port that was skipped, it is a flow
 * this shape cannot hold yet. `runAddProviderInk` is the closer candidate: five
 * linear string steps that today discard everything typed when step three fails
 * validation. It needs only the validate hook.
 *
 * **No "I don't know" row.** Offering a no-opinion option measurably encourages
 * satisficing rather than the work of answering. A typed "not sure" is a signal
 * that the QUESTION was wrong; the caller gets the text and can re-ask.
 */

/** What a step asks for. `text` is the default and the right one for anything open. */
export type WizardStepKind =
  | { kind: 'text' }
  | { kind: 'choice'; choices: string[]; allowOther?: boolean; otherLabel?: string }
  | { kind: 'multi'; choices: string[]; allowOther?: boolean; otherLabel?: string };

export interface WizardStep {
  /** Stable across a re-ask, so an answer survives an edit round trip. */
  id: string;
  /** The question, in the user's language. Rendered as a header, never a field label. */
  question: string;
  /**
   * One short sentence of standing help.
   *
   * Rendered persistently beside the question, never as placeholder text inside
   * the field: a placeholder vanishes the moment someone types, which raises
   * error rates for every user and leaves nothing for a screen reader to
   * announce (WCAG 3.3.2 wants labels or instructions, and a placeholder is
   * neither).
   */
  hint?: string;
  /** Short label for the review screen, where the full question is too long. */
  summary?: string;
  field: WizardStepKind;
  /** When true, Enter on an empty answer moves on instead of holding. */
  optional?: boolean;
}

export type WizardAnswer = string | string[];

export interface WizardSpec {
  /** Optional one-liner shown before the first question — where "three quick questions" goes. */
  intro?: string;
  title?: string;
  steps: WizardStep[];
}

export type WizardResult =
  | { cancelled: false; answers: WizardAnswer[] }
  /** Partial answers survive, matching `AskUserBatchResult`'s own contract. */
  | { cancelled: true; answered: WizardAnswer[] };

/**
 * `asking` walks the steps; `review` is the check-your-answers screen;
 * `editing` is one step re-opened FROM the review.
 *
 * `editing` is a distinct phase rather than a flag because the renderer and the
 * advance rule need opposite answers from it: it renders a step (like `asking`)
 * but returns to the review on commit (unlike `asking`). Folding it into
 * `review` rendered the review on top of itself.
 */
export interface WizardState {
  phase: 'asking' | 'editing' | 'review';
  index: number;
  answers: WizardAnswer[];
  /**
   * The escape-hatch row was picked, so this step renders as a text field.
   *
   * In the state machine rather than a sibling `useState` because every
   * transition clears it, and expressed in the renderer that rule had to be
   * written three times.
   */
  freeform: boolean;
}

export function initialWizardState(steps: readonly WizardStep[]): WizardState {
  return { phase: 'asking', index: 0, answers: steps.map(() => ''), freeform: false };
}

/** True when this step has been answered — the gate on advancing. */
export function isAnswered(step: WizardStep, answer: WizardAnswer | undefined): boolean {
  if (step.optional === true) return true;
  if (Array.isArray(answer)) return answer.length > 0;
  return typeof answer === 'string' && answer.trim().length > 0;
}

/**
 * Records an answer and decides where to go next.
 *
 * Returns the new state; the caller resolves when `phase` is `'review'` and the
 * user commits there. Advancing off the last step lands on the review rather
 * than resolving, so the check-your-answers screen is unskippable by
 * construction rather than by a caller remembering to show it.
 */
export function answerStep(
  state: WizardState,
  steps: readonly WizardStep[],
  answer: WizardAnswer,
): WizardState {
  const answers = [...state.answers];
  answers[state.index] = answer;
  // An edit goes straight back to the review rather than walking the remaining
  // steps again — the user asked to change one thing, not to redo the
  // interview.
  if (state.phase === 'editing')
    return { phase: 'review', index: state.index, answers, freeform: false };
  const next = state.index + 1;
  return next >= steps.length
    ? { phase: 'review', index: state.index, answers, freeform: false }
    : { phase: 'asking', index: next, answers, freeform: false };
}

/** Moves to the previous step. At the first step there is nowhere to go. */
export function goBack(state: WizardState): WizardState {
  // Back out of the escape hatch returns to the choices, not to the last step.
  if (state.freeform) return { ...state, freeform: false };
  // Abandoning an edit returns to the review with the answer untouched.
  if (state.phase === 'editing') return { ...state, phase: 'review' };
  if (state.phase === 'review') {
    // Back from the review re-opens the last question, which is what "back"
    // means to someone who has just been shown a summary.
    return {
      phase: 'asking',
      index: Math.max(0, state.answers.length - 1),
      answers: state.answers,
      freeform: false,
    };
  }
  if (state.index === 0) return state;
  return { ...state, index: state.index - 1 };
}

/** Re-opens one step from the review screen. */
export function editStep(state: WizardState, index: number): WizardState {
  return { phase: 'editing', index, answers: state.answers, freeform: false };
}

/** The escape-hatch row was picked: re-render this same step as a text field. */
export function useFreeform(state: WizardState): WizardState {
  return { ...state, freeform: true };
}

/** Answers as far as they got, for a cancellation. Trailing blanks are not answers. */
export function answeredSoFar(state: WizardState): WizardAnswer[] {
  const blank = (a: WizardAnswer): boolean =>
    Array.isArray(a) ? a.length === 0 : a.trim().length === 0;
  let end = state.answers.length;
  while (end > 0 && blank(state.answers[end - 1])) end--;
  return state.answers.slice(0, end);
}

/** A label the model itself supplied as an escape hatch. */
const OTHER_RE = /^other\b/i;

/**
 * The choice rows for a step, and which of them is the escape hatch.
 *
 * The #230 rule, in ONE place: append a hatch row only when the caller did not
 * already supply an "Other"-shaped choice, and treat either the appended row or
 * any `OTHER_RE`-matching label as the hatch. `App.tsx`'s `buildChoiceMenu`
 * renders the same rule into `MenuEntry`s for a single question; when this was
 * re-derived here instead, the two disagreed twice — a model supplying
 * `['A','B','Other']` with `allowOther` got TWO hatch rows in a batch and one
 * on its own, and the default label read "Something else" in one and "Other" in
 * the other, depending only on how many questions were asked.
 */
export function choiceRows(field: {
  choices: string[];
  allowOther?: boolean;
  otherLabel?: string;
}): { labels: string[]; isHatch: (index: number) => boolean } {
  const hasOwnOther = field.choices.some((c) => OTHER_RE.test(c.trim()));
  const appended = field.allowOther === true && !hasOwnOther;
  const labels = appended
    ? [...field.choices, field.otherLabel?.trim() || 'Other (type your own)']
    : [...field.choices];
  const appendedIndex = appended ? labels.length - 1 : -1;
  return {
    labels,
    isHatch: (index) => index === appendedIndex || OTHER_RE.test((labels[index] ?? '').trim()),
  };
}

/**
 * Renders one answer for the review screen.
 *
 * Bounded, because an answer is free text a user typed and the review shows
 * every one of them at once — the first variable-height surface in the overlay
 * layer.
 */
export function summarizeAnswer(answer: WizardAnswer | undefined, max = 60): string {
  const text = Array.isArray(answer) ? answer.join(', ') : (answer ?? '');
  // Sliced BEFORE the collapse: a whitespace run can shrink the string, so
  // `max * 4` is a safe over-slice, and the full scan on an 8k-character answer
  // measured 51 us — once per visible row, on every arrow key.
  const flat = text
    .slice(0, max * 4)
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length === 0 ? '(not answered)' : truncate(flat, max);
}

/**
 * Converts `ask_user`'s question shape into wizard steps.
 *
 * The two vocabularies stay separate — `ask_user` is a model-facing tool
 * contract and this is a UI contract — but `requestAskUser` renders through the
 * wizard, so every batch of two or more gains back, edit and review without any
 * caller changing.
 */
export function stepsFromQuestions(questions: readonly AskUserQuestion[]): WizardStep[] {
  return questions.map((q, i) => {
    const base = {
      id: `q${i}`,
      question: q.question,
      ...(q.hint ? { hint: q.hint } : {}),
      ...(q.summary ? { summary: q.summary } : {}),
    };
    if (!q.choices || q.choices.length === 0) return { ...base, field: { kind: 'text' as const } };
    const opts = { choices: q.choices, allowOther: q.allowOther, otherLabel: q.otherLabel };
    return {
      ...base,
      field: q.multiSelect
        ? { kind: 'multi' as const, ...opts }
        : { kind: 'choice' as const, ...opts },
    };
  });
}
