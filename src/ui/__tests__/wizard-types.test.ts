import { describe, it, expect } from 'vitest';
import {
  answerStep,
  answeredSoFar,
  choiceRows,
  editStep,
  goBack,
  initialWizardState,
  isAnswered,
  isInfoStep,
  railFor,
  stepError,
  stepsFromQuestions,
  summarizeAnswer,
  type WizardStep,
} from '../overlays/wizard-types.js';

const STEPS: WizardStep[] = [
  { id: 'a', question: 'What would you love to make easier?', field: { kind: 'text' } },
  { id: 'b', question: 'Tell me about the last time.', field: { kind: 'text' } },
  {
    id: 'c',
    question: 'Who else opens it?',
    field: { kind: 'choice', choices: ['Just me', 'A few'] },
  },
];

describe('answering and advancing', () => {
  it('walks forward, keeping each answer at its own index', () => {
    let s = initialWizardState(STEPS);
    s = answerStep(s, STEPS, 'send shifts');
    s = answerStep(s, STEPS, 'last Friday');

    expect(s.index).toBe(2);
    expect(s.answers).toEqual(['send shifts', 'last Friday', '']);
  });

  it('lands on the review after the last step, never straight on a result', () => {
    // Unskippable by construction, rather than by a caller remembering to show
    // a summary — the GOV.UK check-your-answers rule.
    let s = initialWizardState(STEPS);
    for (const a of ['x', 'y', 'z']) s = answerStep(s, STEPS, a);

    expect(s.phase).toBe('review');
    expect(s.answers).toEqual(['x', 'y', 'z']);
  });
});

describe('going back', () => {
  it('preserves the answers already given — the whole reason the batch is owned', () => {
    let s = initialWizardState(STEPS);
    s = answerStep(s, STEPS, 'first');
    s = answerStep(s, STEPS, 'second');
    s = goBack(s);
    s = goBack(s);

    expect(s.index).toBe(0);
    expect(s.answers).toEqual(['first', 'second', '']);
  });

  it('does nothing at the first step rather than cancelling', () => {
    const s = initialWizardState(STEPS);
    expect(goBack(s)).toEqual(s);
  });

  it('from the review, re-opens the last question', () => {
    let s = initialWizardState(STEPS);
    for (const a of ['x', 'y', 'z']) s = answerStep(s, STEPS, a);
    s = goBack(s);

    expect(s.phase).toBe('asking');
    expect(s.index).toBe(2);
  });
});

describe('editing from the review', () => {
  it('changes only the answer that was edited', () => {
    let s = initialWizardState(STEPS);
    for (const a of ['one', 'two', 'three']) s = answerStep(s, STEPS, a);

    s = editStep(s, 1);
    s = answerStep(s, STEPS, 'TWO');

    expect(s.answers).toEqual(['one', 'TWO', 'three']);
  });

  it('renders the STEP, not the review — they are different phases', () => {
    // Folding `editing` into `review` made the parent render the review on top
    // of itself, and the frame still contained the question text because the
    // review row echoes it. Only the phase distinguishes them.
    let s = initialWizardState(STEPS);
    for (const a of ['one', 'two', 'three']) s = answerStep(s, STEPS, a);

    expect(editStep(s, 1).phase).toBe('editing');
  });

  it('abandoning an edit returns to the review with the answer untouched', () => {
    let s = initialWizardState(STEPS);
    for (const a of ['one', 'two', 'three']) s = answerStep(s, STEPS, a);
    s = goBack(editStep(s, 1));

    expect(s.phase).toBe('review');
    expect(s.answers).toEqual(['one', 'two', 'three']);
  });

  it('returns to the review rather than walking the rest again', () => {
    // The user asked to change one thing, not to redo the interview.
    let s = initialWizardState(STEPS);
    for (const a of ['one', 'two', 'three']) s = answerStep(s, STEPS, a);
    s = answerStep(s, STEPS, 'edited');

    expect(s.phase).toBe('review');
  });
});

describe('isAnswered', () => {
  it('treats blank and whitespace as unanswered', () => {
    expect(isAnswered(STEPS[0], '')).toBe(false);
    expect(isAnswered(STEPS[0], '   ')).toBe(false);
    expect(isAnswered(STEPS[0], 'ok')).toBe(true);
  });

  it('treats an empty multi-select as unanswered', () => {
    expect(isAnswered(STEPS[2], [])).toBe(false);
    expect(isAnswered(STEPS[2], ['a'])).toBe(true);
  });

  it('lets an optional step through empty', () => {
    expect(isAnswered({ ...STEPS[0], optional: true }, '')).toBe(true);
  });
});

describe('answeredSoFar', () => {
  it('drops the trailing blanks, so a cancel reports what was really given', () => {
    let s = initialWizardState(STEPS);
    s = answerStep(s, STEPS, 'only this');

    expect(answeredSoFar(s)).toEqual(['only this']);
  });

  it('keeps an interior blank, which is a real optional answer', () => {
    let s = initialWizardState(STEPS);
    s = answerStep(s, STEPS, 'a');
    s = answerStep(s, STEPS, '');
    s = answerStep(s, STEPS, 'c');

    expect(answeredSoFar(s)).toEqual(['a', '', 'c']);
  });

  it('is empty when nothing was answered', () => {
    expect(answeredSoFar(initialWizardState(STEPS))).toEqual([]);
  });
});

describe('summarizeAnswer', () => {
  it('says so plainly when there is no answer', () => {
    expect(summarizeAnswer('')).toBe('(not answered)');
    expect(summarizeAnswer(undefined)).toBe('(not answered)');
  });

  it('flattens newlines, so a review row stays one row', () => {
    // The review is the first variable-height overlay; a multi-line answer
    // would make its height depend on what was typed.
    expect(summarizeAnswer('one\ntwo   three')).toBe('one two three');
  });

  it('bounds a long answer', () => {
    expect(summarizeAnswer('x'.repeat(200), 20)).toHaveLength(20);
  });

  it('joins a multi-select', () => {
    expect(summarizeAnswer(['a', 'b'])).toBe('a, b');
  });
});

describe('stepsFromQuestions', () => {
  it('maps a free-text question to a text step', () => {
    expect(stepsFromQuestions([{ question: 'why?', allowOther: true }])[0].field).toEqual({
      kind: 'text',
    });
  });

  it('maps choices, and multi-select to its own kind', () => {
    const [single, multi] = stepsFromQuestions([
      { question: 'a', choices: ['x', 'y'], allowOther: true },
      { question: 'b', choices: ['x', 'y'], allowOther: false, multiSelect: true },
    ]);
    expect(single.field).toEqual({
      kind: 'choice',
      choices: ['x', 'y'],
      allowOther: true,
      otherLabel: undefined,
      // One keystroke: a clarifying question from the model is a menu, and
      // select-then-continue would put a second press on every one it asks.
      pickAdvances: true,
    });
    expect(multi.field).toEqual({
      kind: 'multi',
      choices: ['x', 'y'],
      allowOther: false,
      otherLabel: undefined,
      // Space toggles and Enter confirms the set, which is what an `ask_user`
      // multi-select has always done.
      pickAdvances: true,
    });
  });

  it('gives every step a distinct id, so an edit addresses one answer', () => {
    const steps = stepsFromQuestions([
      { question: 'a', allowOther: true },
      { question: 'b', allowOther: true },
    ]);
    expect(new Set(steps.map((s) => s.id)).size).toBe(2);
  });
});

describe('choiceRows — the #230 escape-hatch rule, in one place', () => {
  it('appends a hatch when the caller supplied none', () => {
    const { labels, isHatch } = choiceRows({ choices: ['A', 'B'], allowOther: true });
    expect(labels).toEqual(['A', 'B', 'Other (type your own)']);
    expect(isHatch(2)).toBe(true);
    expect(isHatch(0)).toBe(false);
  });

  it('does NOT append a second one when the caller already supplied "Other"', () => {
    // Re-derived in the wizard, this gave a batch two hatch rows where a single
    // question got one — the divergence that made sharing the rule necessary.
    const { labels, isHatch } = choiceRows({ choices: ['A', 'Other'], allowOther: true });
    expect(labels).toEqual(['A', 'Other']);
    expect(isHatch(1)).toBe(true);
  });

  it('uses the same default label the single-question path uses', () => {
    // Two spellings of one row, chosen by how many questions were asked, is the
    // other half of that divergence.
    expect(choiceRows({ choices: ['A'], allowOther: true }).labels[1]).toBe(
      'Other (type your own)',
    );
  });

  it('honours a custom label, and appends nothing without allowOther', () => {
    expect(choiceRows({ choices: ['A'], allowOther: true, otherLabel: 'Say more' }).labels).toEqual(
      ['A', 'Say more'],
    );
    expect(choiceRows({ choices: ['A'] }).labels).toEqual(['A']);
    expect(choiceRows({ choices: ['A'] }).isHatch(0)).toBe(false);
  });
});

describe('initial answers (#447)', () => {
  it('opens each step on its declared initial', () => {
    const steps: WizardStep[] = [
      { id: 'a', question: 'A?', field: { kind: 'text' }, initial: 'alpha' },
      {
        id: 'b',
        question: 'B?',
        field: { kind: 'choice', choices: ['On', 'Off'] },
        initial: 'Off',
      },
    ];
    expect(initialWizardState(steps).answers).toEqual(['alpha', 'Off']);
  });

  it('leaves a step with no initial empty, so existing callers are unchanged', () => {
    expect(initialWizardState(STEPS).answers).toEqual(['', '', '']);
  });

  it('keeps a changed answer rather than the initial when walking back', () => {
    const steps: WizardStep[] = [
      { id: 'a', question: 'A?', field: { kind: 'text' }, initial: 'alpha' },
      { id: 'b', question: 'B?', field: { kind: 'text' }, initial: 'beta' },
    ];
    let state = initialWizardState(steps);
    state = answerStep(state, steps, 'changed');
    state = goBack(state);
    expect(state.index).toBe(0);
    expect(state.answers[0]).toBe('changed');
  });

  it('survives an edit round trip from the review', () => {
    const steps: WizardStep[] = [
      { id: 'a', question: 'A?', field: { kind: 'text' }, initial: 'alpha' },
      { id: 'b', question: 'B?', field: { kind: 'text' }, initial: 'beta' },
    ];
    let state = initialWizardState(steps);
    state = answerStep(state, steps, 'alpha');
    state = answerStep(state, steps, 'beta');
    expect(state.phase).toBe('review');
    state = editStep(state, 0);
    state = answerStep(state, steps, 'edited');
    expect(state.phase).toBe('review');
    // The untouched step keeps its initial, which is what makes "only what
    // changed is written" answerable at the end of a walk.
    expect(state.answers).toEqual(['edited', 'beta']);
  });
});

describe('stepError (#447)', () => {
  const plain: WizardStep = { id: 'a', question: 'A?', field: { kind: 'text' } };

  it('is undefined for a step with no hook, whatever the answer', () => {
    expect(stepError(plain, '')).toBeUndefined();
    expect(stepError(plain, 'anything')).toBeUndefined();
    expect(stepError(plain, ['a', 'b'])).toBeUndefined();
  });

  it('returns the hook message', () => {
    const step: WizardStep = {
      ...plain,
      validate: (a) => (a === '7' ? undefined : 'Enter a whole number.'),
    };
    expect(stepError(step, '7')).toBeUndefined();
    expect(stepError(step, 'x')).toBe('Enter a whole number.');
  });

  it('lets a hook speak for the empty answer, which isAnswered alone cannot', () => {
    const step: WizardStep = {
      ...plain,
      validate: (a) => (String(a).trim() === '' ? 'This one is required.' : undefined),
    };
    // `isAnswered` says the same thing, but only as a boolean — the whole point
    // of running validation first is that the user is told why it held.
    expect(isAnswered(step, '')).toBe(false);
    expect(stepError(step, '')).toBe('This one is required.');
  });
});

describe('info pages (#447)', () => {
  const INFO: WizardStep = {
    id: 'welcome',
    question: 'Welcome',
    field: { kind: 'info', body: ['Hello.'] },
  };

  it('is always answered, so Enter advances without an answer', () => {
    expect(isInfoStep(INFO)).toBe(true);
    // Without this the page holds on Enter and the walk cannot start — the
    // empty-answer rule would be gating a step that has no answer to give.
    expect(isAnswered(INFO, '')).toBe(true);
  });

  it('is not an info page merely for being optional', () => {
    expect(isInfoStep({ ...INFO, field: { kind: 'text' }, optional: true })).toBe(false);
  });
});

describe('railFor', () => {
  const steps: WizardStep[] = [
    { id: 'a', question: 'A', section: 'One', field: { kind: 'text' } },
    { id: 'b', question: 'B', section: 'One', field: { kind: 'text' } },
    { id: 'c', question: 'C', section: 'Two', field: { kind: 'text' } },
  ];

  it('lists sections once, in first-seen order, plus the review', () => {
    expect(railFor(steps, 0).map((e) => e.label)).toEqual(['One', 'Two', 'Review']);
  });

  it('marks the section the walk is in, and only that one', () => {
    expect(railFor(steps, 1).map((e) => e.state)).toEqual(['current', 'todo', 'todo']);
  });

  it('marks a section done only once the walk is past its LAST step', () => {
    // Keyed on the last step rather than the first, so a two-question section
    // does not read as finished while its second question is on screen.
    expect(railFor(steps, 1)[0].state).toBe('current');
    expect(railFor(steps, 2)[0].state).toBe('done');
  });

  it('shows Review as current once the walk is past the last step', () => {
    const rail = railFor(steps, steps.length);
    expect(rail.map((e) => e.state)).toEqual(['done', 'done', 'current']);
  });

  it('is empty when no step declares a section', () => {
    // An `ask_user` batch declares none, and a rail of one row reading "Review"
    // would be chrome that tells the reader nothing.
    expect(railFor([{ id: 'x', question: 'X', field: { kind: 'text' } }], 0)).toEqual([]);
  });
});

describe('railFor across a two-stage flow', () => {
  const steps: WizardStep[] = [
    { id: 'a', question: 'A', section: 'One', field: { kind: 'text' } },
    { id: 'b', question: 'B', section: 'Two', field: { kind: 'text' } },
  ];

  it('shows what came before as done and what is coming as todo', () => {
    // A flow that cannot be one wizard is still one journey. Derived from steps
    // alone the rail restarts at the seam, telling the reader they are at the
    // beginning immediately after finishing a third of the work.
    const rail = railFor(steps, 0, { before: ['Welcome'], after: ['Later'] });
    expect(rail.map((e) => [e.label, e.state])).toEqual([
      ['Welcome', 'done'],
      ['One', 'current'],
      ['Two', 'todo'],
      ['Later', 'todo'],
    ]);
  });

  it('omits the review row while more stages follow', () => {
    // Every stage has its own check-your-answers screen, but only the last is
    // the end of the journey; two "Review" rows in one rail read as a mistake.
    expect(railFor(steps, 0, { after: ['Later'] }).map((e) => e.label)).not.toContain('Review');
    expect(railFor(steps, 0).map((e) => e.label)).toContain('Review');
  });

  it('keeps the last section current on an intermediate review', () => {
    // Past the last step with nothing after it in this wizard, the derived
    // lookup finds no section — which would leave the rail with nothing marked.
    const rail = railFor(steps, steps.length, { after: ['Later'] });
    expect(rail.find((e) => e.state === 'current')?.label).toBe('Two');
  });
});
