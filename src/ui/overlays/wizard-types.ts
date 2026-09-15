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
 * **No branching.** `steps` is a frozen array, so a step's choices cannot depend
 * on an earlier answer. A flow that needs it runs two wizards back to back —
 * which is what `setup-wizard.ts` does, because the model list depends on the
 * provider. That is not a workaround so much as the honest shape: back should
 * not cross a boundary that invalidates the answers after it.
 *
 * **No typed answers.** {@link WizardAnswer} is `string | string[]` and stays
 * that way. A caller with `int` / `float01` / `boolean` / enum fields keeps its
 * own label↔value mapping and validates through {@link WizardStep.validate};
 * widening the union here would push that caller's domain into the type every
 * `ask_user` batch is built from.
 *
 * {@link WizardStep.initial} and {@link WizardStep.validate} were the two
 * genuine gaps, and both are now here (#447). `initial` is prepopulation —
 * without it every re-run of a settings flow starts blank and an unanswered
 * field is indistinguishable from one deliberately cleared. `validate` is what
 * `runAddProviderInk` still wants: five linear string steps that today discard
 * everything typed when step three fails validation.
 *
 * **No "I don't know" row.** Offering a no-opinion option measurably encourages
 * satisficing rather than the work of answering. A typed "not sure" is a signal
 * that the QUESTION was wrong; the caller gets the text and can re-ask.
 */

/** What a step asks for. `text` is the default and the right one for anything open. */
export type WizardStepKind =
  /**
   * A page that asks nothing — a welcome, or an explanation that has to be read
   * before the questions make sense. Enter advances.
   *
   * It is a STEP rather than something the host renders before the wizard,
   * because back has to work: reaching it with `^B` from question one is the
   * behaviour a reader expects, and a host-rendered preamble is gone by then.
   * It carries no answer, so {@link isAnswered} is always true for it and the
   * review screen leaves it out — a row reading "Welcome — (not answered)"
   * would be an invitation to go and fix something that is not broken.
   */
  | { kind: 'info'; body: string[] }
  | { kind: 'text' }
  | {
      kind: 'choice';
      choices: string[];
      allowOther?: boolean;
      otherLabel?: string;
      /**
       * Rows that are shown but cannot be picked, keyed by label, with the
       * reason to say when one is highlighted.
       *
       * Shown rather than hidden, because the absence of an option answers no
       * question: a provider missing from the list looks unsupported, where a
       * greyed one with "no key" beside it says what to do about it. The
       * cursor still lands on them for the same reason — the explanation has to
       * be reachable.
       */
      unavailable?: Record<string, string>;
      /**
       * Rows appended after the options that resolve the step with their own
       * label — "Continue to the next step" on a page whose options are things
       * to DO rather than answers to give.
       *
       * Separate from `choices` because they are not answers: they carry no
       * tick, take no digit shortcut, and must not be what `initial` opens on.
       * A page whose Enter already means "choose this and move on" needs none —
       * a second row doing the same thing would have to guess which option was
       * meant once the cursor had left them.
       */
      actions?: string[];
      /**
       * Right-aligned detail for a row, keyed by label, with leader dots filling
       * the gap — the table-of-contents shape `output.ts`'s welcome box already
       * uses for `Version……v0.9.0`.
       *
       * Separate from the label because the label is the ANSWER vocabulary: a
       * decoder that had to strip a decorated suffix back off would be a second
       * copy of the formatting to keep in step, and the decoration changes with
       * the terminal width.
       */
      trailing?: Record<string, { text: string; tick?: boolean }>;
      /**
       * A sentence about one row, shown on the reserved reason row while that
       * row is highlighted.
       *
       * Distinct from {@link trailing}, which is right-aligned detail sized to
       * fit BESIDE the label — a blurb, a key hint, a status. A note is prose
       * and gets the full width, which is what a consequence needs: the row
       * that dissolves every permission gate had its warning declared in the
       * field registry and rendered nowhere, because a label is all a choice
       * step used to carry.
       */
      notes?: Record<string, string>;
      /**
       * Enter on a row resolves the step, instead of selecting it.
       *
       * The default is select-then-continue: Enter marks a row with `✓`, and
       * moving down to the Continue control moves on. One model on every screen
       * is worth a keystroke — a page whose rows are things to DO (a hub) and a
       * page whose rows are answers otherwise behave differently under the same
       * key, and the reader has to learn which is which.
       *
       * Set where picking IS the act: a hub row that opens an editor, and an
       * `ask_user` menu, which is a single question whose whole point is that it
       * answers in one keystroke. On a `multi` field it means Enter confirms the
       * checked set rather than toggling one more row.
       */
      pickAdvances?: boolean;
    }
  | {
      kind: 'multi';
      choices: string[];
      allowOther?: boolean;
      otherLabel?: string;
      /** Enter confirms the checked set instead of toggling one more row. */
      pickAdvances?: boolean;
    };

export interface WizardStep {
  /** Stable across a re-ask, so an answer survives an edit round trip. */
  id: string;
  /**
   * The group this step belongs to — "Tool safety", "Voice" — shown above the
   * question so a long flat walk still reads as sections.
   *
   * A field rather than a prefix baked into {@link question}, which is what the
   * setup flow did first (`Tool safety — Tool mode`): the renderer would then
   * have to split on a delimiter to style the two halves differently, and any
   * question that legitimately contained an em dash would break it.
   */
  section?: string;
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
  /**
   * What the review says when this step was left blank.
   *
   * `(not answered)` is right for a question that wanted an answer and did not
   * get one. It is wrong — actively misleading — for an optional step where
   * blank IS the answer: a skipped API-key page whose key is already stored
   * read as unanswered on the summary screen, next to a provider that works.
   */
  emptySummary?: string;
  field: WizardStepKind;
  /** When true, Enter on an empty answer moves on instead of holding. */
  optional?: boolean;
  /**
   * What the Next row says instead of the state-derived default.
   *
   * The default is worded from what Enter will do to the ANSWER — keep it,
   * change it, continue — which is right until the step's meaning is not about
   * the answer at all. The live case is an API-key field on a provider that
   * already has one stored: the honest label is "Keep the stored key", and
   * nothing the renderer can see tells it that.
   *
   * A FUNCTION where the label depends on what has been typed, which the spec
   * cannot know because `steps` is frozen. The same key field is the case: with
   * something in the buffer the button saves it, and with the buffer empty it
   * does not — labelling both the same way is how that page ended up drawing two
   * controls a reader could only read as "back".
   */
  nextLabel?: string | ((answer: string) => string);
  /**
   * The answer this step opens with.
   *
   * The whole of prepopulation: a text step starts with this in its buffer, a
   * choice step opens with its cursor on the matching row. Absent means the
   * previous behaviour, an empty answer.
   *
   * It is deliberately a {@link WizardAnswer} and not a separate "current value"
   * type, so `answers[i] === steps[i].initial` is the caller's change test. A
   * setup flow needs exactly that: writing a value the user did not touch is how
   * a profile silently shadows an environment variable forever.
   */
  initial?: WizardAnswer;
  /**
   * Reject an answer with a message, instead of accepting it.
   *
   * Consulted by {@link stepError} BEFORE the empty-answer rule, so a hook may
   * speak for the empty case too — which is what a required numeric field wants
   * ("Enter a number between 1 and 200"), where holding silently just looks
   * broken. Returning `undefined` accepts.
   *
   * Pure, and called on every keystroke-free Enter rather than continuously: it
   * must not be where a caller does I/O. That is a statement about THIS hook,
   * not a ban on I/O in a wizard — {@link WizardStep.check} is the explicit door
   * for that, and it exists partly so this one does not become the tempting one.
   */
  validate?: (answer: WizardAnswer) => string | undefined;
  /**
   * An optional check the reader can run against the answer, on demand.
   *
   * The only ASYNC field on a step, and the only one that reaches outside the
   * overlay. It exists for the API-key page: a pasted key is worth testing
   * before it is saved, and every other way of finding out costs a whole flow.
   *
   * **The verdict is inert.** It never enters `WizardState`, never reaches
   * {@link stepError} / `isAnswered` / `answerStep`, and never gates the answer
   * — running the check is optional, and a failed one still lets the step
   * commit. That is what keeps the state machine as pure as it was.
   *
   * **Never built from model input.** `stepsFromQuestions` constructs steps
   * explicitly from `AskUserQuestion`, which has no such key, and a function
   * would not survive the model's JSON in any case — so injection is
   * structurally impossible. Worth stating because this field is a CAPABILITY
   * (the network, and whatever the reader has typed) rather than data, which is
   * a different thing for `WizardStep` to carry than everything above it.
   *
   * `run` is handed an `AbortSignal` and must settle: the overlay draws no
   * spinner, so a hang and a freeze are indistinguishable there.
   */
  check?: {
    /** The control's label, e.g. `Test key`. */
    label: string;
    /** In-flight label. Keep it the same display width, or the footer jiggles. */
    busyLabel: string;
    run: (answer: string, signal: AbortSignal) => Promise<StepCheckResult>;
  };
}

/**
 * What a {@link WizardStep.check} concluded.
 *
 * Three states, deliberately: a boolean cannot say "I could not tell", so every
 * uncertain answer would render as a failure — which is the exact shape of the
 * bug the API-key check exists to avoid.
 */
export interface StepCheckResult {
  tone: 'ok' | 'bad' | 'unknown';
  message: string;
}

export type WizardAnswer = string | string[];

export interface WizardSpec {
  /** Optional one-liner shown before the first question — where "three quick questions" goes. */
  intro?: string;
  title?: string;
  steps: WizardStep[];
  /**
   * Resolve on the last answer instead of ending at the review.
   *
   * The review is a check-your-ANSWERS screen, and it is unskippable by
   * construction precisely so a caller cannot forget it. A navigational page —
   * a hub whose rows are things to do, or a single field opened from one — has
   * no batch to check, and a summary reading "Providers — anthropic" is a
   * screen nobody can act on. Opt-in, so the property still holds everywhere
   * nobody opted out.
   */
  skipReview?: boolean;
  /**
   * Back on the first step resolves with `back: true` instead of being absent.
   *
   * A flow that cannot be one wizard is still one journey — setup is three,
   * because the model list cannot be built before a provider is chosen — and
   * without this, Back simply disappears at every seam. Four of setup's five
   * screens are single-step specs, so "Back exists on step two onwards" meant
   * almost nowhere.
   */
  backExits?: boolean;
  /**
   * Sections either side of THIS wizard, for the progress rail.
   *
   * A flow that cannot be one wizard is still one journey to the person walking
   * it. Setup runs two — the model list cannot be built until a provider is
   * chosen — and a rail derived from `steps` alone restarts at the boundary,
   * which reads as "you are at the beginning" immediately after finishing a
   * third of the work. `before` is shown done and `after` todo, so the rail is
   * continuous across the seam.
   */
  railContext?: { before?: string[]; after?: string[] };
  /**
   * The splash above the card: a small line, block lettering, and a tagline
   * under it on the right.
   *
   * Opt-in, and every part supplied by the caller. `WizardCard` also draws
   * every `ask_user` batch the model raises mid-turn, and a product masthead
   * over a clarifying question would be signing the wrong thing; a hard-coded
   * banner in the overlay would make that unavoidable rather than a choice. So
   * the component knows only "some rows to draw big and two lines around them",
   * and setup is what decides they say Bernard.
   */
  masthead?: {
    /** Small, left-aligned, above the banner. */
    intro?: string;
    /** Block-lettering rows, drawn in the accent colour. */
    banner: string[];
    /** One line under the banner, right-aligned against the card's edge. */
    tagline?: string;
  };
}

export type WizardResult =
  | { cancelled: false; answers: WizardAnswer[] }
  /** Partial answers survive, matching `AskUserBatchResult`'s own contract. */
  | {
      cancelled: true;
      answered: WizardAnswer[];
      /**
       * Back was pressed on the FIRST step of a spec that declared
       * {@link WizardSpec.backExits} — the caller should reopen whatever came
       * before this wizard.
       *
       * A flag on the cancelled variant rather than a third case, so a caller
       * that does not know about it still compiles and still stops. Treating an
       * unhandled "go back" as a cancel loses a step; treating it as a
       * completion would lose the answers.
       */
      back?: boolean;
    };

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
  return {
    phase: 'asking',
    index: 0,
    answers: steps.map((s) => s.initial ?? ''),
    freeform: false,
  };
}

/**
 * The message that should stop this answer being accepted, if any.
 *
 * Validation is checked BEFORE {@link isAnswered}, which is the whole reason
 * this is a function rather than an inline `step.validate?.(answer)` at the one
 * call site: with the order reversed a hook could never see an empty answer,
 * because the empty-answer rule would already have held the step — silently,
 * which is the behaviour a validated field most needs to replace.
 *
 * A step with no hook returns `undefined` for every answer, so the empty-answer
 * rule stays the only gate and existing callers are unaffected.
 */
export function stepError(step: WizardStep, answer: WizardAnswer): string | undefined {
  return step.validate?.(answer);
}

/** True when an info page — which can never be answered, and never needs to be. */
export function isInfoStep(step: WizardStep): boolean {
  return step.field.kind === 'info';
}

/** True when this step has been answered — the gate on advancing. */
export function isAnswered(step: WizardStep, answer: WizardAnswer | undefined): boolean {
  if (isInfoStep(step) || step.optional === true) return true;
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

/** Rows shown after the options: the step's own actions, then Back. */
export function actionRows(step: WizardStep): string[] {
  return step.field.kind === 'choice' ? (step.field.actions ?? []) : [];
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
/** The label of the control that moves a select-then-continue page on. */
export const CONTINUE_LABEL = 'Continue';

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
      // One keystroke, deliberately: a clarifying question from the model is a
      // menu, and making it select-then-continue would put a second press on
      // every question the agent asks. On a multi-select that means space
      // toggles and Enter confirms the set, which is what it has always done.
      field: q.multiSelect
        ? { kind: 'multi' as const, ...opts, pickAdvances: true }
        : { kind: 'choice' as const, ...opts, pickAdvances: true },
    };
  });
}

/** A section in the progress rail, and where the walk is relative to it. */
export interface RailEntry {
  label: string;
  state: 'done' | 'current' | 'todo';
}

/**
 * The progress rail, derived from the steps rather than declared beside them.
 *
 * Sections, not steps: a 36-question walk cannot list every question in a rail
 * a terminal can hold, and "which part of setup am I in" is the question a
 * reader actually has. Derived so a spec cannot declare a rail that disagrees
 * with the steps it is a rail for.
 *
 * `atIndex` past the last step means the review, which is why the caller passes
 * `steps.length` for it rather than a separate flag — the rail then shows every
 * section done and Review current, with no branch here or at the call site.
 */
export function railFor(
  steps: readonly WizardStep[],
  atIndex: number,
  context: { before?: string[]; after?: string[] } = {},
  reviewLabel = 'Review',
): RailEntry[] {
  const order: string[] = [];
  const lastIndexOf = new Map<string, number>();
  steps.forEach((step, i) => {
    const name = step.section;
    if (name === undefined || name === '') return;
    if (!lastIndexOf.has(name)) order.push(name);
    lastIndexOf.set(name, i);
  });
  // No sections declared means no rail — an `ask_user` batch, which has none.
  if (order.length === 0) return [];

  // Past the last step is this wizard's review screen. With more stages to come
  // that is not a milestone of its own, so the last section stays current rather
  // than leaving the rail with nothing marked at all.
  const pastEnd = atIndex >= steps.length;
  const holdLast = pastEnd && (context.after?.length ?? 0) > 0;
  const currentSection = holdLast ? order[order.length - 1] : steps[atIndex]?.section;
  const entries: RailEntry[] = order.map((label) => ({
    label,
    state:
      label === currentSection
        ? 'current'
        : // Done once the walk is past that section's LAST step, so a section
          // revisited by an edit reads as current again rather than as done.
          (lastIndexOf.get(label) ?? -1) < atIndex
          ? 'done'
          : 'todo',
  }));
  const before: RailEntry[] = (context.before ?? []).map((label) => ({ label, state: 'done' }));
  const after: RailEntry[] = (context.after ?? []).map((label) => ({ label, state: 'todo' }));
  // The review row belongs to the LAST wizard only. A stage with more to come
  // still has its own check-your-answers screen, but it is a confirm on the way
  // through rather than the end of the journey, and two "Review" rows in one
  // rail read as a mistake.
  const review: RailEntry[] =
    after.length > 0
      ? []
      : [{ label: reviewLabel, state: atIndex >= steps.length ? 'current' : 'todo' }];
  return [...before, ...entries, ...after, ...review];
}

/** Why this row cannot be picked, or `undefined` when it can. */
export function unavailableReason(step: WizardStep, label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  return step.field.kind === 'choice' ? step.field.unavailable?.[label] : undefined;
}

/** The right-aligned detail for a row, if it has any. */
/** The note for a row, or `undefined`. */
/**
 * The forward button's words for the answer currently in hand.
 *
 * One reader for both shapes, so a step kind that only handles the string form
 * would silently render `[object Function]` rather than fail — the failure mode
 * of widening a field and updating three of four call sites.
 */
export function nextLabelFor(step: WizardStep, answer: string, fallback: string): string {
  const label = step.nextLabel;
  if (label === undefined) return fallback;
  return typeof label === 'function' ? label(answer) : label;
}

export function rowNote(step: WizardStep, label: string | undefined): string | undefined {
  if (label === undefined || step.field.kind !== 'choice') return undefined;
  return step.field.notes?.[label];
}

export function rowTrailing(
  step: WizardStep,
  label: string | undefined,
): { text: string; tick?: boolean } | undefined {
  if (label === undefined) return undefined;
  return step.field.kind === 'choice' ? step.field.trailing?.[label] : undefined;
}
