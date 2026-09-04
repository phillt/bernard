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
 * **No progress fraction.** Conrad et al. randomised progress feedback in web
 * surveys: breakoff was 12.7% with no feedback and **21.8%** when the indicator
 * implied slow progress — nearly double. On-demand was best, and 37% of users
 * never asked for it. An adaptive interview does not know its own length, so a
 * fraction is both a guess and the discouraging variant. `intro` states the
 * shape in words instead, once, at the start.
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
}

export function initialWizardState(steps: readonly WizardStep[]): WizardState {
  return { phase: 'asking', index: 0, answers: steps.map(() => '') };
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
  if (state.phase !== 'asking') return { phase: 'review', index: state.index, answers };
  const next = state.index + 1;
  return next >= steps.length
    ? { phase: 'review', index: state.index, answers }
    : { phase: 'asking', index: next, answers };
}

/** Moves to the previous step. At the first step there is nowhere to go. */
export function goBack(state: WizardState): WizardState {
  // Abandoning an edit returns to the review with the answer untouched.
  if (state.phase === 'editing') return { ...state, phase: 'review' };
  if (state.phase === 'review') {
    // Back from the review re-opens the last question, which is what "back"
    // means to someone who has just been shown a summary.
    return {
      phase: 'asking',
      index: Math.max(0, state.answers.length - 1),
      answers: state.answers,
    };
  }
  if (state.index === 0) return state;
  return { ...state, index: state.index - 1 };
}

/** Re-opens one step from the review screen. */
export function editStep(state: WizardState, index: number): WizardState {
  return { phase: 'editing', index, answers: state.answers };
}

/** Answers as far as they got, for a cancellation. Trailing blanks are not answers. */
export function answeredSoFar(state: WizardState): WizardAnswer[] {
  const out = [...state.answers];
  while (out.length > 0) {
    const last = out[out.length - 1];
    const blank = Array.isArray(last) ? last.length === 0 : last.trim().length === 0;
    if (!blank) break;
    out.pop();
  }
  return out;
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
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '(not answered)';
  return flat.length <= max ? flat : flat.slice(0, max - 1).trimEnd() + '…';
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
    const base = { id: `q${i}`, question: q.question };
    if (!q.choices || q.choices.length === 0) return { ...base, field: { kind: 'text' as const } };
    const opts = {
      choices: q.choices,
      ...(q.allowOther ? { allowOther: true } : {}),
      ...(q.otherLabel ? { otherLabel: q.otherLabel } : {}),
    };
    return {
      ...base,
      field: q.multiSelect
        ? { kind: 'multi' as const, ...opts }
        : { kind: 'choice' as const, ...opts },
    };
  });
}
