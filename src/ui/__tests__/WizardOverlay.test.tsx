import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { DimensionsProvider } from '../DimensionsContext.js';
import { WizardOverlay } from '../overlays/WizardOverlay.js';
import type { WizardResult, WizardSpec } from '../overlays/wizard-types.js';
import {
  ESC,
  ENTER,
  ARROW_DOWN,
  ARROW_LEFT,
  ARROW_RIGHT,
  ARROW_UP,
  CTRL_B,
  tick,
} from './_keys.js';

const SPEC: WizardSpec = {
  intro: 'Three quick questions.',
  steps: [
    { id: 'a', question: 'What would you love to make easier?', field: { kind: 'text' } },
    { id: 'b', question: 'Tell me about the last time.', field: { kind: 'text' } },
    {
      id: 'c',
      question: 'Who else opens it?',
      summary: 'Who else',
      field: { kind: 'choice', choices: ['Just me', 'A few people'] },
    },
  ],
};

async function mount(onResolve: (r: WizardResult) => void, spec: WizardSpec = SPEC) {
  // `DimensionsProvider` is mandatory: without it `useDimensionsCtx` silently
  // falls back to 80x24 rather than failing, which hides a windowing bug.
  const harness = render(
    createElement(DimensionsProvider, null, createElement(WizardOverlay, { spec, onResolve })),
  );
  // `useInput` subscribes asynchronously, so the first keystroke is dropped
  // without this — and a dropped keystroke here reads as "the component did
  // not advance", which is a long way from the cause.
  await tick();
  return harness;
}

async function type(stdin: { write: (s: string) => void }, text: string) {
  stdin.write(text);
  await tick();
}

/**
 * Selects the highlighted row, then walks to Continue and presses it.
 *
 * Choice steps are select-then-continue (#447): Enter marks a row, the control
 * at the foot moves on. One model on every screen, at the cost of a keystroke.
 *
 * Takes the option count and where the cursor is, because Continue sits at
 * `options` — a fixed number of arrow presses would silently select a
 * neighbouring option on any step of a different size.
 */
async function pickAndContinue(
  stdin: { write: (s: string) => void },
  options: number,
  cursorAt = 0,
) {
  await type(stdin, ENTER);
  for (let i = cursorAt; i < options; i++) await type(stdin, ARROW_DOWN);
  await type(stdin, ENTER);
}

/** Answers the three-step SPEC and lands on the review. */
async function answerAll(stdin: { write: (s: string) => void }) {
  await type(stdin, 'one');
  await type(stdin, ENTER);
  await type(stdin, 'two');
  await type(stdin, ENTER);
  await pickAndContinue(stdin, 2);
}

/**
 * Moves past the answer rows onto the Save control and presses it.
 *
 * `answers + 1` presses, not `answers`: committing is the CONTROL now, the same
 * gesture every other page uses to move on, rather than a last list row reading
 * "Looks right — go ahead".
 */
async function confirmReview(stdin: { write: (s: string) => void }, answers = 3) {
  for (let i = 0; i < answers; i++) await type(stdin, ARROW_DOWN);
  await type(stdin, ENTER);
}

describe('WizardOverlay', () => {
  it('shows the intro once, on the first step only', async () => {
    const { stdin, lastFrame } = await mount(vi.fn());
    expect(stripAnsi(lastFrame() ?? '')).toContain('Three quick questions.');

    await type(stdin, 'send shifts');
    await type(stdin, ENTER);

    expect(stripAnsi(lastFrame() ?? '')).not.toContain('Three quick questions.');
  });

  it('renders NO progress fraction — this is a research finding, not an omission', async () => {
    // Randomised progress feedback measured 12.7% breakoff with none against
    // 21.8% when it implied slow progress. An adaptive interview cannot know
    // its length, so any fraction is a guess in the harmful direction. Asserted
    // on the frame because a later "improvement" would quietly add one.
    const { stdin, lastFrame } = await mount(vi.fn());
    for (const step of ['one', 'two']) {
      await type(stdin, step);
      await type(stdin, ENTER);
    }
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).not.toMatch(/\b\d\s*(of|\/)\s*\d\b/);
    expect(frame).not.toContain('Step ');
  });

  it('goes back and keeps the answers already given', async () => {
    // The whole reason the component owns the batch rather than sequencing
    // separate overlays: a per-step overlay is unmounted and its answer is gone.
    const { stdin, lastFrame } = await mount(vi.fn());
    await type(stdin, 'send shifts');
    await type(stdin, ENTER);
    await type(stdin, 'last Friday');
    await type(stdin, ENTER);

    await type(stdin, CTRL_B);
    expect(stripAnsi(lastFrame() ?? '')).toContain('last Friday');

    await type(stdin, CTRL_B);
    expect(stripAnsi(lastFrame() ?? '')).toContain('send shifts');
  });

  it('offers no back on the first step', async () => {
    const { lastFrame } = await mount(vi.fn());
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('back');
  });

  it('holds on an empty answer rather than cancelling', async () => {
    // Cancel-on-empty is right for a one-shot prompt and wrong mid-wizard,
    // where a stray Enter would throw away everything already answered.
    const onResolve = vi.fn();
    const { stdin, lastFrame } = await mount(onResolve);
    await type(stdin, ENTER);

    expect(onResolve).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? '')).toContain('What would you love to make easier?');
  });

  it('lands on the review after the last step, not on a result', async () => {
    const onResolve = vi.fn();
    const { stdin, lastFrame } = await mount(onResolve);
    await answerAll(stdin);

    expect(onResolve).not.toHaveBeenCalled();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Here is what I heard');
    // Committing is the CONTROL, the same gesture every other page uses, not a
    // last list row reading "Looks right — go ahead".
    expect(frame).toContain('Save and finish');
    expect(frame).not.toContain('Looks right');
  });

  it('resolves only when the review is confirmed', async () => {
    const onResolve = vi.fn();
    const { stdin } = await mount(onResolve);
    await answerAll(stdin);
    await confirmReview(stdin);

    expect(onResolve).toHaveBeenCalledWith({
      cancelled: false,
      answers: ['one', 'two', 'Just me'],
    });
  });

  it('edits one answer from the review and changes only that one', async () => {
    const onResolve = vi.fn();
    const { stdin, lastFrame } = await mount(onResolve);
    await answerAll(stdin);

    // Edit the second answer.
    await type(stdin, ARROW_DOWN);
    await type(stdin, ENTER);
    // The STEP, not the review — the review row echoes the question text too,
    // so asserting on that alone passes while the review renders itself.
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('Save and finish');

    await type(stdin, ' revised');
    await type(stdin, ENTER);

    // Straight back to the review — the user changed one thing, not the flow.
    expect(stripAnsi(lastFrame() ?? '')).toContain('Here is what I heard');

    await confirmReview(stdin);
    expect(onResolve).toHaveBeenCalledWith({
      cancelled: false,
      answers: ['one', 'two revised', 'Just me'],
    });
  });

  it('Esc cancels the whole wizard and reports what was answered', async () => {
    const onResolve = vi.fn();
    const { stdin } = await mount(onResolve);
    await type(stdin, 'only this');
    await type(stdin, ENTER);
    await type(stdin, ESC);

    expect(onResolve).toHaveBeenCalledWith({ cancelled: true, answered: ['only this'] });
  });

  it('routes an escape-hatch choice to a text field on the same step', async () => {
    const onResolve = vi.fn();
    const spec: WizardSpec = {
      steps: [
        {
          id: 'only',
          question: 'Who else opens it?',
          field: { kind: 'choice', choices: ['Just me'], allowOther: true },
        },
      ],
    };
    const { stdin, lastFrame } = await mount(onResolve, spec);

    await type(stdin, ARROW_DOWN);
    await type(stdin, ENTER);
    // Now a text field, still on the same question.
    expect(stripAnsi(lastFrame() ?? '')).toContain('Who else opens it?');

    await type(stdin, 'my whole team');
    await type(stdin, ENTER);
    await type(stdin, ARROW_DOWN);
    await type(stdin, ENTER);

    expect(onResolve).toHaveBeenCalledWith({ cancelled: false, answers: ['my whole team'] });
  });

  it('fits a long review inside a short terminal', async () => {
    // The first variable-height surface in this layer. Each row is bounded to
    // one terminal row, so the window arithmetic applies — but the budget has
    // to be measured, and getting exactly that wrong is what windowing exists
    // to fix.
    const spec: WizardSpec = {
      steps: Array.from({ length: 30 }, (_, i) => ({
        id: `s${i}`,
        question: `Question number ${i} which is deliberately quite long indeed`,
        field: { kind: 'text' as const },
      })),
    };
    const onResolve = vi.fn();
    const { stdin, lastFrame } = await mount(onResolve, spec);
    for (let i = 0; i < 30; i++) {
      await type(stdin, `answer ${i}`);
      await type(stdin, ENTER);
    }

    const frame = stripAnsi(lastFrame() ?? '').replace(/\n+$/, '');
    expect(frame).toContain('Here is what I heard');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
  });

  it('keeps a review row to one terminal row however long the question is', async () => {
    // The window arithmetic counts ITEMS and assumes each is one row, and the
    // review only ever bounded the ANSWER (`summarizeAnswer` caps it at 60).
    // A long question plus a short answer therefore wrapped, and the frame
    // overflowed the budget it had been given — latent at full width, live the
    // moment the card narrowed it.
    const spec: WizardSpec = {
      steps: [
        {
          id: 'long',
          question: `A question that is ${'very '.repeat(30)}long indeed`,
          field: { kind: 'text' as const },
        },
      ],
    };
    const { stdin, lastFrame } = await mount(vi.fn(), spec);
    await type(stdin, 'short');
    await type(stdin, ENTER);
    const frame = stripAnsi(lastFrame() ?? '');
    const rows = frame.split('\n').filter((l) => l.includes('A question that is'));
    expect(rows).toHaveLength(1);
  });
});

describe('WizardOverlay — prepopulation and validation (#447)', () => {
  it('opens a text step with its initial in the buffer, and Enter keeps it', async () => {
    const onResolve = vi.fn();
    const spec: WizardSpec = {
      steps: [{ id: 'a', question: 'Rate?', field: { kind: 'text' }, initial: '175' }],
    };
    const { stdin, lastFrame } = await mount(onResolve, spec);
    expect(stripAnsi(lastFrame() ?? '')).toContain('175');
    await type(stdin, ENTER);
    await type(stdin, ARROW_DOWN); // past the answer row, onto Save
    await type(stdin, ENTER);
    expect(onResolve).toHaveBeenCalledWith({ cancelled: false, answers: ['175'] });
  });

  it('opens a choice step on its current value, not on the first row', async () => {
    const onResolve = vi.fn();
    const spec: WizardSpec = {
      steps: [
        {
          id: 'mode',
          question: 'Tool mode?',
          field: { kind: 'choice', choices: ['read-only', 'write', 'unrestricted'] },
          initial: 'write',
        },
      ],
    };
    const { stdin } = await mount(onResolve, spec);
    // No navigation at all: the step opens with `write` already selected, so
    // Continue hands it straight back. Landing on row 1 would answer
    // 'read-only' — the failure this seeding exists to stop, since a walk of
    // prepopulated settings is mostly Continue.
    await type(stdin, ARROW_DOWN); // 'unrestricted'
    await type(stdin, ARROW_DOWN); // onto the Continue control
    await type(stdin, ENTER);
    await type(stdin, ARROW_DOWN); // past the answer row, onto Save
    await type(stdin, ENTER);
    expect(onResolve).toHaveBeenCalledWith({ cancelled: false, answers: ['write'] });
  });

  it('holds on an invalid answer and shows why, instead of advancing', async () => {
    const onResolve = vi.fn();
    const spec: WizardSpec = {
      steps: [
        {
          id: 'steps',
          question: 'Max steps?',
          field: { kind: 'text' },
          initial: '25',
          validate: (a) => (/^\d+$/.test(String(a)) ? undefined : 'Enter a whole number.'),
        },
        { id: 'after', question: 'Next question', field: { kind: 'text' } },
      ],
    };
    const { stdin, lastFrame } = await mount(onResolve, spec);
    await type(stdin, 'x');
    await type(stdin, ENTER);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Enter a whole number.');
    // Still on the same question — an advance here would silently record 'x'.
    expect(frame).toContain('Max steps?');
    expect(frame).not.toContain('Next question');
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('clears the rejection as soon as the buffer changes', async () => {
    const spec: WizardSpec = {
      steps: [
        {
          id: 'steps',
          question: 'Max steps?',
          field: { kind: 'text' },
          validate: (a) => (/^\d+$/.test(String(a)) ? undefined : 'Enter a whole number.'),
        },
      ],
    };
    const { stdin, lastFrame } = await mount(vi.fn(), spec);
    await type(stdin, 'x');
    await type(stdin, ENTER);
    expect(stripAnsi(lastFrame() ?? '')).toContain('Enter a whole number.');
    await type(stdin, '7');
    // The message described a buffer that no longer exists.
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('Enter a whole number.');
  });

  it('reserves the message row, so being refused does not change the step height', async () => {
    const withHook: WizardSpec = {
      steps: [
        {
          id: 'a',
          question: 'Q?',
          field: { kind: 'text' },
          validate: (a) => (String(a) === 'bad' ? 'No.' : undefined),
        },
      ],
    };
    const { stdin, lastFrame } = await mount(vi.fn(), withHook);
    const rows = (f: string) => f.replace(/\n+$/, '').split('\n').length;
    const before = rows(stripAnsi(lastFrame() ?? ''));
    await type(stdin, 'bad');
    await type(stdin, ENTER);
    expect(stripAnsi(lastFrame() ?? '')).toContain('No.');
    // A row that appears only on rejection reflows the frame under a reader who
    // is mid-correction — `OverlayFooter`'s rule, applied here.
    expect(rows(stripAnsi(lastFrame() ?? ''))).toBe(before);
  });
});

describe('WizardOverlay — the dialog frame (#447)', () => {
  it('puts the question in a header above everything and the actions at the foot', async () => {
    const { lastFrame } = await mount(vi.fn());
    const rows = stripAnsi(lastFrame() ?? '')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const headerRow = rows.findIndex((l) => l.includes('What would you love to make easier?'));
    const nextRow = rows.findIndex((l) => l.includes('Continue'));
    expect(headerRow).toBeGreaterThanOrEqual(0);
    // The question is the first thing in the card and the actions the last —
    // the order a dialog is read in.
    expect(nextRow).toBeGreaterThan(headerRow);
  });

  it('keeps dismissal to the line under the card, said once', async () => {
    // It used to be said twice in one frame: a close control top-right and the
    // same word in the key line below.
    const { lastFrame } = await mount(vi.fn());
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame.match(/esc/g) ?? []).toHaveLength(1);
  });

  it('says what Enter does in words, not as a key legend', async () => {
    const spec: WizardSpec = {
      steps: [
        {
          id: 'a',
          question: 'Pick',
          field: { kind: 'choice', choices: ['one', 'two'] },
          initial: 'one',
        },
      ],
    };
    const { lastFrame } = await mount(vi.fn(), spec);
    // The control says what IT does; the hint line says what Enter does where
    // the cursor is. A button that renamed itself to a neighbour's action is how
    // a reader ends up pressing the wrong thing.
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Continue');
    expect(frame).toContain('↵ select');
    // …and the control does NOT carry a return glyph while the cursor is on an
    // option, where Enter selects rather than continuing.
    expect(frame).not.toContain('Continue  ↵');
  });

  it('goes back from the review to the last question', async () => {
    // `goBack` has handled the review since it was written, and is tested —
    // but no renderer called it, so the one transition a reader most expects
    // from a summary screen was unreachable.
    const spec: WizardSpec = {
      steps: [
        { id: 'a', question: 'First question', field: { kind: 'text' } },
        { id: 'b', question: 'Second question', field: { kind: 'text' } },
      ],
    };
    const { stdin, lastFrame } = await mount(vi.fn(), spec);
    await type(stdin, 'one');
    await type(stdin, ENTER);
    await type(stdin, 'two');
    await type(stdin, ENTER);
    expect(stripAnsi(lastFrame() ?? '')).toContain('Here is what I heard');
    await type(stdin, CTRL_B);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Second question');
    expect(frame).not.toContain('Here is what I heard');
  });
});

describe('WizardOverlay — info pages (#447)', () => {
  const WELCOME: WizardSpec = {
    steps: [
      {
        id: 'welcome',
        section: 'Welcome',
        question: 'Welcome to Bernard',
        field: {
          kind: 'info',
          body: [
            'A paragraph long enough that it has to be wrapped by something, and the question is which something does it.',
            '',
            'A second paragraph, also long enough to wrap more than once inside a card of any reasonable width at all.',
          ],
        },
        nextLabel: 'Start setup',
      },
      { id: 'q', question: 'A real question', field: { kind: 'text' } },
    ],
  };

  it('advances on Enter without recording an answer', async () => {
    const onResolve = vi.fn();
    const { stdin, lastFrame } = await mount(onResolve, WELCOME);
    expect(stripAnsi(lastFrame() ?? '')).toContain('Welcome to Bernard');
    await type(stdin, ENTER);
    expect(stripAnsi(lastFrame() ?? '')).toContain('A real question');
  });

  it('leaves the info page out of the review', async () => {
    // A row reading "Welcome — (not answered)" invites the reader to go and fix
    // something that is not broken.
    const { stdin, lastFrame } = await mount(vi.fn(), WELCOME);
    await type(stdin, ENTER);
    await type(stdin, 'an answer');
    await type(stdin, ENTER);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Here is what I heard');
    expect(frame).toContain('A real question — an answer');
    expect(frame).not.toContain('Welcome to Bernard —');
  });

  it('wraps its prose to the width it is actually given', async () => {
    // The body is pre-wrapped so Ink cannot wrap it a second time — Ink wraps
    // with `trim: false` and keeps the break space at the START of every
    // continuation line, which reads as a ragged left edge on the one screen
    // that is nothing but prose. A content width that forgets the rail's
    // divider is three columns optimistic, so the pre-wrapped lines overflow
    // and Ink breaks them again.
    //
    // The fixture is uniform short words on purpose: whether a second wrap
    // leaves a visible leading space depends on where the break lands, so a
    // paragraph of ordinary prose passes or fails on its own wording. With
    // every gap a break candidate, an overflowing line always breaks at one.
    const spec: WizardSpec = {
      steps: [
        {
          id: 'welcome',
          section: 'Welcome',
          question: 'Wrapping',
          field: { kind: 'info', body: ['ab '.repeat(300).trim()] },
        },
        { id: 'q', section: 'Later', question: 'Q', field: { kind: 'text' } },
      ],
    };
    const { lastFrame } = await mount(vi.fn(), spec);
    const rows = stripAnsi(lastFrame() ?? '')
      .split('\n')
      .filter((l) => l.includes('│'));
    const bodyCells = rows.map((l) => l.split('│').at(-2) ?? '').filter((c) => c.includes('ab'));
    expect(bodyCells.length).toBeGreaterThan(3);
    for (const cell of bodyCells) expect(cell.startsWith('   ')).toBe(false);
  });
});

describe('WizardOverlay — rows that cannot be picked (#447)', () => {
  const SPEC: WizardSpec = {
    steps: [
      {
        id: 'p',
        section: 'Providers',
        question: 'Which one?',
        field: {
          kind: 'choice',
          choices: ['anthropic', 'openai', 'xai'],
          unavailable: { xai: 'xai has no key stored, so it cannot be the default.' },
        },
        initial: 'anthropic',
      },
    ],
  };

  const rowFor = (frame: string, name: string): string =>
    frame.split('\n').find((l) => new RegExp(`\\d+\\. ${name}\\b`).test(l)) ?? '';

  it('marks the answer in force with ✓, separately from the cursor', async () => {
    // A `[✓ key set]` badge on every configured row read as "this one is
    // selected", competing with the cursor marker for the same meaning.
    const { stdin, lastFrame } = await mount(vi.fn(), SPEC);
    const first = stripAnsi(lastFrame() ?? '');
    // Hard right, past the leader dots — the one place a tick ever appears.
    expect(rowFor(first, 'anthropic')).toMatch(/1\. anthropic ·+ ✓ *│/);
    expect(rowFor(first, 'openai')).not.toContain('✓');
    await type(stdin, ARROW_DOWN);
    // The tick stays put while the cursor moves: they are different facts.
    expect(rowFor(stripAnsi(lastFrame() ?? ''), 'anthropic')).toContain('✓');
    expect(rowFor(stripAnsi(lastFrame() ?? ''), 'openai')).not.toContain('✓');
  });

  it('refuses to commit an unavailable row, and says why', async () => {
    // A SECOND step, so "did not advance" is observable. With one step a commit
    // lands on the review, whose summary row still contains the question text —
    // so both the obvious assertions pass whether or not the guard is there.
    const twoStep: WizardSpec = {
      steps: [
        SPEC.steps[0],
        { id: 'after', question: 'The next question', field: { kind: 'text' } },
      ],
    };
    const onResolve = vi.fn();
    const { stdin, lastFrame } = await mount(onResolve, twoStep);
    await type(stdin, ARROW_DOWN);
    await type(stdin, ARROW_DOWN);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('xai has no key stored');
    // The key line says so too, rather than inviting an Enter that does nothing.
    expect(frame).toContain('↵ unavailable');
    await type(stdin, ENTER);
    expect(onResolve).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('The next question');
    // …and it did not become the selection either, so Continue cannot hand it
    // back by the back door.
    expect(rowFor(stripAnsi(lastFrame() ?? ''), 'xai')).not.toContain('✓');
  });

  it('still shows the row rather than hiding it', async () => {
    // A provider missing from the list looks unsupported; a greyed one with a
    // reason beside it says what to do about it.
    const { lastFrame } = await mount(vi.fn(), SPEC);
    expect(stripAnsi(lastFrame() ?? '')).toContain('xai');
  });

  it('reserves the reason row, so the frame does not jump as the cursor moves', async () => {
    const { stdin, lastFrame } = await mount(vi.fn(), SPEC);
    const rows = (f: string) => f.replace(/\n+$/, '').split('\n').length;
    const before = rows(stripAnsi(lastFrame() ?? ''));
    await type(stdin, ARROW_DOWN);
    await type(stdin, ARROW_DOWN);
    expect(stripAnsi(lastFrame() ?? '')).toContain('no key stored');
    expect(rows(stripAnsi(lastFrame() ?? ''))).toBe(before);
  });

  it('says what a blank optional answer meant, instead of "(not answered)"', async () => {
    const spec: WizardSpec = {
      steps: [
        {
          id: 'k',
          question: 'API key',
          summary: 'anthropic key',
          field: { kind: 'text' },
          optional: true,
          emptySummary: 'kept the stored key',
        },
      ],
    };
    const { stdin, lastFrame } = await mount(vi.fn(), spec);
    await type(stdin, ENTER);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('anthropic key — kept the stored key');
    expect(frame).not.toContain('(not answered)');
  });
});

describe('WizardOverlay — footer controls are focusable (#447)', () => {
  const SPEC: WizardSpec = {
    // No review: the action resolves the wizard, which is what a hub does.
    skipReview: true,
    steps: [
      { id: 'first', question: 'First', field: { kind: 'text' } },
      {
        id: 'hub',
        question: 'Pick one',
        field: {
          kind: 'choice',
          choices: ['alpha', 'beta'],
          actions: ['Continue to the next step'],
          trailing: { alpha: { text: 'ends1234', tick: true }, beta: { text: 'no key' } },
          // A hub: Enter acts on the row rather than choosing it, so no row
          // carries a selection tick and the only ✓ is the trailing one.
          pickAdvances: true,
        },
      },
    ],
  };

  async function atHub() {
    const onResolve = vi.fn();
    const h = await mount(onResolve, SPEC);
    await type(h.stdin, 'x');
    await type(h.stdin, ENTER);
    return { ...h, onResolve };
  }

  it('right-aligns a row detail with leader dots', async () => {
    const { lastFrame } = await atHub();
    const row = stripAnsi(lastFrame() ?? '')
      .split('\n')
      .find((l) => l.includes('alpha'))!;
    // Many dots, not one: the fixture's preview deliberately contains none, so
    // this cannot pass on the preview's own punctuation.
    expect((row.match(/·/g) ?? []).length).toBeGreaterThan(5);
    // The tick sits to the RIGHT of the preview, which is itself right-aligned.
    expect(row.indexOf('ends1234')).toBeGreaterThan(row.indexOf('alpha'));
    expect(row.indexOf('✓')).toBeGreaterThan(row.indexOf('ends1234'));
  });

  it('moves onto the Continue control instead of adding a row that duplicates it', async () => {
    const { stdin, lastFrame } = await atHub();
    const listRows = () =>
      stripAnsi(lastFrame() ?? '')
        .split('\n')
        .filter((l) => /\d+\.\s/.test(l)).length;
    expect(listRows()).toBe(2);
    await type(stdin, ARROW_DOWN);
    await type(stdin, ARROW_DOWN);
    const frame = stripAnsi(lastFrame() ?? '');
    // The action is named on the control, and the list did not grow a row.
    expect(frame).toContain('▸ Continue to the next step');
    expect(listRows()).toBe(2);
  });

  it('resolves with the action label when its control is chosen', async () => {
    const { stdin, onResolve } = await atHub();
    await type(stdin, ARROW_DOWN);
    await type(stdin, ARROW_DOWN);
    await type(stdin, ENTER);
    expect(onResolve).toHaveBeenCalledWith({
      cancelled: false,
      answers: ['x', 'Continue to the next step'],
    });
  });

  it('moves onto Back, and Enter there goes back', async () => {
    // ← from Continue, not ↓ through it: the two controls are one row.
    const { stdin, lastFrame, unmount } = await atHub();
    await type(stdin, ARROW_DOWN);
    await type(stdin, ARROW_DOWN);
    stdin.write(ARROW_LEFT);
    await tick(60);
    expect(stripAnsi(lastFrame() ?? '')).toContain('▸ ← Back');
    await type(stdin, ENTER);
    expect(stripAnsi(lastFrame() ?? '')).toContain('First');
    unmount();
  });

  it('does not scroll the option list when the cursor steps onto a control', async () => {
    const { stdin, lastFrame } = await atHub();
    const before = stripAnsi(lastFrame() ?? '');
    await type(stdin, ARROW_DOWN);
    await type(stdin, ARROW_DOWN);
    const after = stripAnsi(lastFrame() ?? '');
    for (const option of ['alpha', 'beta']) {
      expect(before).toContain(option);
      expect(after).toContain(option);
    }
  });
});

describe('WizardOverlay — a value the list does not offer (#447)', () => {
  const SPEC: WizardSpec = {
    steps: [
      {
        id: 'model',
        question: 'Model?',
        field: { kind: 'choice', choices: ['alpha', 'beta'] },
        // In force, and not on the list — reachable whenever the source of the
        // rows is known-incomplete, which the model catalog is.
        initial: 'gamma',
      },
      { id: 'after', question: 'The next question', field: { kind: 'text' } },
    ],
  };

  it('ticks nothing rather than falling to row one', async () => {
    const { lastFrame } = await mount(vi.fn(), SPEC);
    // Row one used to carry the tick, so the page claimed `alpha` was the
    // reader's current value.
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('✓');
  });

  it('refuses Continue, and says why instead of swallowing the keystroke', async () => {
    const onResolve = vi.fn();
    const { stdin, lastFrame } = await mount(onResolve, SPEC);
    for (let i = 0; i < 3; i++) await type(stdin, ARROW_DOWN); // onto Continue
    const onControl = stripAnsi(lastFrame() ?? '');
    expect(onControl).toContain('Nothing is selected yet');
    await type(stdin, ENTER);
    // A second step, so "did not advance" is observable at all.
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('The next question');
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('moves on once a row is actually picked', async () => {
    // Guard the guard: a page that could never continue would satisfy both
    // assertions above while being useless.
    const onResolve = vi.fn();
    const { stdin, lastFrame } = await mount(onResolve, SPEC);
    await type(stdin, ENTER); // pick 'alpha'
    for (let i = 0; i < 3; i++) await type(stdin, ARROW_DOWN);
    await type(stdin, ENTER);
    expect(stripAnsi(lastFrame() ?? '')).toContain('The next question');
  });
});

/**
 * Every step reaches its controls with the arrow keys (#447).
 *
 * The footer draws Continue and Back on every screen, and only the choice step
 * could reach them — so on a numeric settings question ↓ did nothing, which is
 * the one thing a reader tries after typing a value. A control you can see and
 * cannot reach is worse than no control.
 */
/**
 * A row can say what picking it costs (#447).
 *
 * The field registry has carried a `description` per option since it was
 * written and `buildStep` mapped options to LABELS, so it rendered nowhere —
 * including on the one row that dissolves every permission gate, whose warning
 * existed only in the source.
 */
/**
 * A long hint keeps a straight left edge (#447).
 *
 * Ink wraps with `trim: false`, keeping the break space at the START of a
 * continuation line — and only where the break lands after one, so the edge is
 * ragged on some lines and not others. Survivable while a hint was one line;
 * not once the descriptions grew to say what each setting is FOR.
 */
describe('WizardOverlay — the masthead signs the screen', () => {
  // Wider than the tagline below it, so "flush to the banner's right edge" and
  // "flush to the card's" are different answers and the test can tell them
  // apart. Equal widths would pass either way.
  const BANNER = ['█████████████████╗', '█████████████████║', '╚════════════════╝'];
  const TAG = 'a tagline';
  const spec = (masthead?: WizardSpec['masthead']): WizardSpec => ({
    ...(masthead ? { masthead } : {}),
    steps: [{ id: 'q', question: 'Which?', field: { kind: 'choice', choices: ['a', 'b'] } }],
  });

  it('centres the block and hangs its parts on the banner, not the card', async () => {
    const { lastFrame } = await mount(
      vi.fn(),
      spec({ intro: 'Welcome to', banner: BANNER, tagline: TAG }),
    );
    const rows = stripAnsi(lastFrame() ?? '').split('\n');
    const at = rows.findIndex((l) => l.includes('Welcome to'));
    const box = rows.findIndex((l) => l.includes('╭'));
    const bannerRow = rows.findIndex((l) => l.includes(BANNER[0]));
    const tag = rows.findIndex((l) => l.includes(TAG));
    expect(at).toBeGreaterThanOrEqual(0);
    // In order, and all of it outside the box.
    expect(bannerRow).toBeGreaterThan(at);
    expect(tag).toBeGreaterThan(bannerRow);
    expect(box).toBeGreaterThan(tag);

    const left = (i: number) => rows[i].length - rows[i].trimStart().length;
    const right = (i: number) => rows[i].trimEnd().length;
    // The small line starts where the lettering does…
    expect(left(at)).toBe(left(bannerRow));
    // …and the tagline ends where the lettering ends.
    expect(right(tag)).toBe(right(bannerRow));
    // Centred in the card, which is what makes those two edges narrower than it.
    expect(left(bannerRow)).toBeGreaterThan(left(box));
    expect(right(bannerRow)).toBeLessThan(right(box));
  });

  it('drops the whole splash rather than wrapping block lettering', async () => {
    // Block lettering cannot reflow, so a banner too wide for the card goes
    // entirely — the rule the rail follows, for the same reason.
    const wide = ['x'.repeat(400)];
    const { lastFrame } = await mount(vi.fn(), spec({ intro: 'Welcome to', banner: wide }));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).not.toContain('Welcome to');
    expect(frame).not.toContain('xxxx');
  });

  it('sizes the block to its widest part, so a long tagline cannot spill', async () => {
    const long = 'a tagline considerably longer than the lettering above it';
    const { lastFrame } = await mount(
      vi.fn(),
      spec({ intro: 'Welcome to', banner: BANNER, tagline: long }),
    );
    const rows = stripAnsi(lastFrame() ?? '').split('\n');
    const box = rows.findIndex((l) => l.includes('╭'));
    const tag = rows.findIndex((l) => l.includes(long));
    expect(tag).toBeGreaterThanOrEqual(0);
    expect(rows[tag].trimEnd().length).toBeLessThanOrEqual(rows[box].trimEnd().length);
  });

  it('signs nothing when a spec declares none', async () => {
    // Guard the guard, and the reason the field is opt-in: `WizardCard` also
    // draws every `ask_user` batch, and a product splash over a clarifying
    // question would be signing the wrong thing.
    const { lastFrame } = await mount(vi.fn(), spec());
    const rows = stripAnsi(lastFrame() ?? '')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(rows[0]).toContain('╭');
  });
});

describe('WizardOverlay — prose above a step is pre-wrapped', () => {
  it('starts no body line with a space', async () => {
    const spec: WizardSpec = {
      steps: [
        {
          id: 'q',
          // A section, so the RAIL renders. That is not decoration: the rail
          // narrows the content column, and the artifact only appears when a
          // break lands immediately after a space at the wrap column — at the
          // full width this same text wraps cleanly and the test would pass
          // with the pre-wrap deleted. Verified by deleting it.
          section: 'Model',
          question: 'Active lineup',
          // Long enough to wrap several times at the card's width, with the
          // breaks landing after spaces — which is the only case that shows it.
          hint: 'A named set of models — a strong one for hard work, a cheap one for small jobs. Lets Bernard spend less without you choosing a model each time. Currently anthropic (default).',
          field: { kind: 'choice', choices: ['one', 'two'] },
          initial: 'one',
        },
      ],
      intro: 'Each question opens on its current value, so Continue keeps it.',
    };
    const { lastFrame } = await mount(vi.fn(), spec);
    const rows = stripAnsi(lastFrame() ?? '').split('\n');
    // The prose band: everything between the rule under the title and the first
    // option row. Bounded at both ends because an option row carries its own
    // marker gutter and legitimately starts further in, and the card is centred
    // so there is leading whitespace before the border on every line.
    const start = rows.findIndex((l) => l.includes('───'));
    const end = rows.findIndex((l, i) => i > start && /\d+\.\s/.test(l));
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start + 2);
    const prose = rows
      .slice(start + 1, end)
      // Between the LAST TWO bars. A line has two when there is no rail and
      // three when there is — left border, divider, right border — so anchoring
      // on the first would fold the rail column into the band, and anchoring
      // only on the last leaves the card's blank rows reading as content.
      .map((l) => {
        const bars = [...l.matchAll(/│/g)].map((m) => m.index ?? -1);
        return bars.length < 2 ? '' : l.slice(bars[bars.length - 2] + 1, bars[bars.length - 1]);
      })
      .filter((l) => l.trim().length > 0);
    // Several wrapped lines from the hint plus the intro, or this is asserting
    // about nothing.
    expect(prose.length).toBeGreaterThan(3);
    // Two spaces is the card's own padding; a third is Ink's break space, and
    // it lands on some continuation lines and not others.
    expect(prose.filter((l) => l.startsWith('   '))).toEqual([]);
  });
});

describe('WizardOverlay — a highlighted row can carry a note', () => {
  const SPEC: WizardSpec = {
    steps: [
      {
        id: 'mode',
        question: 'Tool mode?',
        field: {
          kind: 'choice',
          choices: ['read-only', 'write', 'unrestricted'],
          notes: { unrestricted: 'Dissolves both gates.' },
        },
        initial: 'read-only',
      },
    ],
  };

  it('shows the note for the highlighted row only', async () => {
    const { stdin, lastFrame } = await mount(vi.fn(), SPEC);
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('Dissolves both gates');
    await type(stdin, ARROW_DOWN);
    await type(stdin, ARROW_DOWN);
    expect(stripAnsi(lastFrame() ?? '')).toContain('Dissolves both gates');
    await type(stdin, ARROW_UP);
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('Dissolves both gates');
  });

  it('does not grow a row for it', async () => {
    // The reason row is reserved unconditionally, so a note claims a row that
    // already exists — otherwise the frame reflows as the cursor moves.
    const { stdin, lastFrame } = await mount(vi.fn(), SPEC);
    const rows = (f: string) => f.replace(/\n+$/, '').split('\n').length;
    const before = rows(stripAnsi(lastFrame() ?? ''));
    await type(stdin, ARROW_DOWN);
    await type(stdin, ARROW_DOWN);
    expect(rows(stripAnsi(lastFrame() ?? ''))).toBe(before);
  });

  it('lets a refusal win the row over a note', async () => {
    // Both claim the same row; why you CANNOT pick this outranks what picking
    // it would cost.
    const spec: WizardSpec = {
      steps: [
        {
          id: 'p',
          question: 'Which?',
          field: {
            kind: 'choice',
            choices: ['a', 'b'],
            notes: { b: 'a note about b' },
            unavailable: { b: 'b has no key stored.' },
          },
          initial: 'a',
        },
      ],
    };
    const { stdin, lastFrame } = await mount(vi.fn(), spec);
    await type(stdin, ARROW_DOWN);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('b has no key stored');
    expect(frame).not.toContain('a note about b');
  });
});

describe('WizardOverlay — the controls are reachable from every step kind', () => {
  const textSpec: WizardSpec = {
    steps: [
      // Seeded, because an empty required text step HOLDS on Enter — so an
      // unseeded first step would never let these cases reach step two.
      { id: 'first', question: 'First', field: { kind: 'text' }, initial: 'x' },
      { id: 'n', question: 'Threshold?', field: { kind: 'text' }, initial: '0.15' },
    ],
  };

  it('moves ↓ from the buffer onto Continue, and ↑ back to it', async () => {
    const { stdin, lastFrame } = await mount(vi.fn(), textSpec);
    await type(stdin, ENTER); // past step one, onto the numeric step
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('▸ Continue');
    await type(stdin, ARROW_DOWN);
    expect(stripAnsi(lastFrame() ?? '')).toContain('▸ Continue');
    await type(stdin, ARROW_UP);
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('▸ Continue');
  });

  it('commits from Continue with the value in the buffer', async () => {
    const onResolve = vi.fn();
    const { stdin } = await mount(onResolve, { ...textSpec, skipReview: true });
    await type(stdin, ENTER);
    await type(stdin, ARROW_DOWN);
    await type(stdin, ENTER);
    expect(onResolve).toHaveBeenCalledWith({ cancelled: false, answers: ['x', '0.15'] });
  });

  it('gives the buffer back the moment anything is typed', async () => {
    // Swallowing a keystroke on a control would reproduce the original
    // complaint one key over — a key that does nothing, with nothing on screen
    // explaining why.
    const { stdin, lastFrame } = await mount(vi.fn(), textSpec);
    await type(stdin, ENTER);
    await type(stdin, ARROW_DOWN);
    await type(stdin, '9');
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('0.159');
    expect(frame).not.toContain('▸ Continue');
  });

  it('reaches Back sideways from Continue, as a choice step does', async () => {
    const { stdin, lastFrame } = await mount(vi.fn(), textSpec);
    await type(stdin, ENTER);
    await type(stdin, ARROW_DOWN);
    await type(stdin, ARROW_LEFT);
    expect(stripAnsi(lastFrame() ?? '')).toContain('▸ ← Back');
    await type(stdin, ARROW_RIGHT);
    expect(stripAnsi(lastFrame() ?? '')).toContain('▸ Continue');
  });

  it('says which keys move, instead of leaving the row to esc alone', async () => {
    const { stdin, lastFrame } = await mount(vi.fn(), textSpec);
    await type(stdin, ENTER);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('↑/↓');
    expect(frame).toContain('^b');
  });

  it('opens an info step on Continue and switches sideways', async () => {
    // No body to move between, so ←/→ rather than ↑/↓ — and the hints say so
    // rather than advertising a key with nowhere to go.
    const onResolve = vi.fn();
    const spec: WizardSpec = {
      skipReview: true,
      // So Back exists on the first step — otherwise the ←/→ half of this has
      // no second control to reach and the assertions pass vacuously.
      backExits: true,
      steps: [
        { id: 'w', question: 'Welcome', field: { kind: 'info', body: ['hello'] } },
        { id: 'after', question: 'Next', field: { kind: 'text' } },
      ],
    };
    const { stdin, lastFrame } = await mount(onResolve, spec);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('▸ Continue');
    // ↑/↓ is not advertised, because there is nothing above the controls for it
    // to reach — the keys that move here are ←/→.
    expect(frame).not.toContain('↑/↓');
    expect(frame).toContain('←/→');

    await type(stdin, ARROW_LEFT);
    expect(stripAnsi(lastFrame() ?? '')).toContain('▸ ← Back');
    await type(stdin, ARROW_RIGHT);
    expect(stripAnsi(lastFrame() ?? '')).toContain('▸ Continue');
    await type(stdin, ENTER);
    expect(stripAnsi(lastFrame() ?? '')).toContain('Next');
  });

  it('Back on an info step resolves as back, not as an answer', async () => {
    const onResolve = vi.fn();
    const spec: WizardSpec = {
      skipReview: true,
      backExits: true,
      steps: [{ id: 'w', question: 'Welcome', field: { kind: 'info', body: ['hello'] } }],
    };
    const { stdin } = await mount(onResolve, spec);
    await type(stdin, ARROW_LEFT);
    await type(stdin, ENTER);
    expect(onResolve).toHaveBeenCalledWith({ cancelled: true, back: true, answered: [] });
  });
});

describe('WizardOverlay — select, then continue (#447)', () => {
  const SPEC: WizardSpec = {
    steps: [
      {
        id: 'mode',
        question: 'Tool mode?',
        field: { kind: 'choice', choices: ['read-only', 'write', 'unrestricted'] },
        initial: 'read-only',
      },
    ],
  };

  it('Enter marks a row instead of moving on', async () => {
    const onResolve = vi.fn();
    const { stdin, lastFrame } = await mount(onResolve, SPEC);
    await type(stdin, ARROW_DOWN);
    await type(stdin, ENTER);
    const frame = stripAnsi(lastFrame() ?? '');
    // The tick moved to the row Enter was pressed on…
    const row = (name: string) => frame.split('\n').find((l) => l.includes(name)) ?? '';
    expect(row('write')).toMatch(/·+ ✓ *│/);
    expect(row('read-only')).not.toContain('✓');
    // …and the step did not advance.
    expect(frame).toContain('Tool mode?');
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('Continue hands back what is marked, not what the cursor is on', async () => {
    // The cursor ends up on a control, so a page that submitted "the highlighted
    // row" would have nothing to hand back — which is the whole reason the
    // selection is tracked separately.
    const onResolve = vi.fn();
    const { stdin } = await mount(onResolve, SPEC);
    await type(stdin, ARROW_DOWN);
    await type(stdin, ENTER); // select 'write'
    await type(stdin, ARROW_DOWN); // 'unrestricted'
    await type(stdin, ARROW_DOWN); // the Continue control
    await type(stdin, ENTER);
    await type(stdin, ARROW_DOWN); // review: onto Save
    await type(stdin, ENTER);
    expect(onResolve).toHaveBeenCalledWith({ cancelled: false, answers: ['write'] });
  });

  it('accepts a prepopulated page with Continue alone', async () => {
    // The walk this exists for is mostly "yes, that one": the step opens with
    // its current value marked, so nothing needs re-picking.
    const onResolve = vi.fn();
    const { stdin } = await mount(onResolve, SPEC);
    for (let i = 0; i < 3; i++) await type(stdin, ARROW_DOWN);
    await type(stdin, ENTER);
    await type(stdin, ARROW_DOWN);
    await type(stdin, ENTER);
    expect(onResolve).toHaveBeenCalledWith({ cancelled: false, answers: ['read-only'] });
  });

  it('keeps one keystroke for an ask_user menu', async () => {
    // A clarifying question from the model is a menu; select-then-continue would
    // put a second press on every question the agent asks.
    const onResolve = vi.fn();
    const spec: WizardSpec = {
      skipReview: true,
      steps: [
        {
          id: 'q',
          question: 'Which?',
          field: { kind: 'choice', choices: ['a', 'b'], pickAdvances: true },
        },
      ],
    };
    const { stdin, lastFrame } = await mount(onResolve, spec);
    // …and no tick, because there is no selection to mark on such a page.
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('✓');
    await type(stdin, ENTER);
    expect(onResolve).toHaveBeenCalledWith({ cancelled: false, answers: ['a'] });
  });
});

describe('WizardOverlay — moving between the two controls (#447)', () => {
  const SPEC: WizardSpec = {
    steps: [
      { id: 'first', question: 'First', field: { kind: 'text' } },
      {
        id: 'pick',
        question: 'Pick',
        field: { kind: 'choice', choices: ['alpha', 'beta'] },
        initial: 'alpha',
      },
    ],
  };

  /** Past the text step, then down to the Continue control. */
  async function atControls() {
    const onResolve = vi.fn();
    const h = await mount(onResolve, SPEC);
    await type(h.stdin, 'x');
    await type(h.stdin, ENTER);
    await type(h.stdin, ARROW_DOWN);
    await type(h.stdin, ARROW_DOWN);
    return { ...h, onResolve };
  }

  /**
   * A keystroke with room around it.
   *
   * Ink 5 anchors its parse at the start of whatever a TTY read returned, so two
   * arrows written back to back can arrive as one chunk and the second is lost —
   * the coalescing `useRawKeys` documents. `type`'s default tick is enough for a
   * printable character and not for a three-byte escape.
   */
  async function press(stdin: { write: (s: string) => void }, keys: string) {
    stdin.write(keys);
    await tick(60);
  }

  it('reaches Back sideways from Continue', async () => {
    const { stdin, lastFrame, unmount } = await atControls();
    expect(stripAnsi(lastFrame() ?? '')).toContain('▸ Continue');
    await press(stdin, ARROW_LEFT);
    expect(stripAnsi(lastFrame() ?? '')).toContain('▸ ← Back');
    unmount();
  });

  it('comes back to Continue with →', async () => {
    const { stdin, lastFrame, unmount } = await atControls();
    await press(stdin, ARROW_LEFT);
    await press(stdin, ARROW_RIGHT);
    expect(stripAnsi(lastFrame() ?? '')).toContain('▸ Continue');
    unmount();
  });

  it('does not walk DOWN into Back', async () => {
    // The two are ONE row on screen, so ↓ through them would be the cursor
    // moving down where nothing is — which is why ← reaches Back instead.
    const { stdin, lastFrame, unmount } = await atControls();
    await press(stdin, ARROW_DOWN);
    expect(stripAnsi(lastFrame() ?? '')).toContain('▸ Continue');
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('▸ ← Back');
    unmount();
  });

  it('returns to the list from Back too, not sideways into Continue', async () => {
    // The case that distinguishes this from plain list navigation: from Back,
    // the row above is Continue, and stepping onto it would be ↑ moving the
    // cursor along a row rather than out of the controls.
    const { stdin, lastFrame, unmount } = await atControls();
    await press(stdin, ARROW_LEFT);
    expect(stripAnsi(lastFrame() ?? '')).toContain('▸ ← Back');
    await press(stdin, ARROW_UP);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('> 2.');
    expect(frame).not.toContain('▸ Continue');
    expect(frame).not.toContain('▸ ← Back');
    unmount();
  });

  it('returns to the END of the list on ↑, not to its top', async () => {
    const { stdin, lastFrame, unmount } = await atControls();
    await press(stdin, ARROW_UP);
    const frame = stripAnsi(lastFrame() ?? '');
    // The row the cursor left, which is where a reader expects to be put back.
    expect(frame).toContain('> 2.');
    expect(frame).not.toContain('▸ Continue');
    unmount();
  });

  it('names the back chord in the key line, since the control no longer spells it', async () => {
    const { lastFrame, unmount } = await atControls();
    const frame = stripAnsi(lastFrame() ?? '');
    unmount();
    expect(frame).toContain('^b back');
    expect(frame).toContain('←/→ switch');
    // The control carries the label; the chord belongs with the other keys.
    expect(frame).not.toContain('← Back (^b)');
  });

  it('offers neither control movement nor a back chord where there is nowhere to go', async () => {
    // Step one of a wizard: an arrow hint for a key that does nothing, and a
    // chord for a journey with no previous step, are both lies.
    const { stdin, lastFrame } = await mount(vi.fn(), SPEC);
    await type(stdin, 'x');
    await type(stdin, ENTER);
    await type(stdin, CTRL_B); // back to step one, where Back is unavailable
    await type(stdin, ARROW_DOWN);
    await type(stdin, ARROW_DOWN);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('First');
    expect(frame).not.toContain('^b back');
    expect(frame).not.toContain('←/→ switch');
  });
});

describe('WizardOverlay — Back across a stage boundary (#447)', () => {
  const ONE_STEP: WizardSpec = {
    skipReview: true,
    backExits: true,
    steps: [{ id: 'only', question: 'Only question', field: { kind: 'text' } }],
  };

  it('offers Back on the first step when the spec says one exists', async () => {
    // Without this a single-step spec simply has no Back — which was four of
    // setup's five screens, so "Back exists from step two" meant almost nowhere.
    const { lastFrame, unmount } = await mount(vi.fn(), ONE_STEP);
    expect(stripAnsi(lastFrame() ?? '')).toContain('← Back');
    unmount();
  });

  it('resolves with back, so the caller can reopen what came before', async () => {
    const onResolve = vi.fn();
    const { stdin, unmount } = await mount(onResolve, ONE_STEP);
    await type(stdin, 'typed');
    await type(stdin, CTRL_B);
    expect(onResolve).toHaveBeenCalledWith({
      cancelled: true,
      answered: expect.anything(),
      back: true,
    });
    unmount();
  });

  it('has no Back where nothing came before', async () => {
    const { lastFrame, unmount } = await mount(vi.fn(), { ...ONE_STEP, backExits: undefined });
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('← Back');
    unmount();
  });

  it('keeps Esc meaning cancel, not back', async () => {
    // A caller that ignores the flag still stops, which is why it rides on the
    // cancelled variant — but Esc must not claim a step was retraced.
    const onResolve = vi.fn();
    const { stdin, unmount } = await mount(onResolve, ONE_STEP);
    await type(stdin, ESC);
    expect(onResolve).toHaveBeenCalledWith({ cancelled: true, answered: expect.anything() });
    unmount();
  });
});

describe('WizardOverlay — the review moves on like every other page (#447)', () => {
  const SPEC: WizardSpec = {
    steps: [
      { id: 'a', question: 'First question', summary: 'First', field: { kind: 'text' } },
      { id: 'b', question: 'Second question', summary: 'Second', field: { kind: 'text' } },
    ],
  };

  async function atReview() {
    const onResolve = vi.fn();
    const h = await mount(onResolve, SPEC);
    await type(h.stdin, 'one');
    await type(h.stdin, ENTER);
    await type(h.stdin, 'two');
    await type(h.stdin, ENTER);
    return { ...h, onResolve };
  }

  it('commits through the Continue control, not a list row', async () => {
    // A review that needed its own gesture was the one screen where the reader
    // had to learn a second one.
    const { stdin, lastFrame, onResolve, unmount } = await atReview();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Save and finish');
    expect(frame).not.toContain('Looks right');
    // Two answers, so two presses to step off the list and onto the control.
    await type(stdin, ARROW_DOWN);
    await type(stdin, ARROW_DOWN);
    await type(stdin, ENTER);
    expect(onResolve).toHaveBeenCalledWith({ cancelled: false, answers: ['one', 'two'] });
    unmount();
  });

  it('names the back chord in its key line', async () => {
    // It was the one surface whose hints omitted it, which is how "there is no
    // back button" survives a page that has one.
    const { lastFrame, unmount } = await atReview();
    expect(stripAnsi(lastFrame() ?? '')).toContain('^b back');
    unmount();
  });

  it('counts only the answers in its position, not the controls', async () => {
    const { lastFrame, unmount } = await atReview();
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('of 3');
    unmount();
  });

  it('still edits an answer from a row', async () => {
    const { stdin, lastFrame, unmount } = await atReview();
    await type(stdin, ENTER);
    expect(stripAnsi(lastFrame() ?? '')).toContain('First question');
    unmount();
  });
});
