import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { DimensionsProvider } from '../DimensionsContext.js';
import { WizardOverlay } from '../overlays/WizardOverlay.js';
import type { WizardResult, WizardSpec } from '../overlays/wizard-types.js';
import { ESC, ENTER, ARROW_DOWN, CTRL_B, tick } from './_keys.js';

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

/** Answers the three-step SPEC and lands on the review. */
async function answerAll(stdin: { write: (s: string) => void }) {
  await type(stdin, 'one');
  await type(stdin, ENTER);
  await type(stdin, 'two');
  await type(stdin, ENTER);
  await type(stdin, ENTER); // the choice step commits the highlighted row
}

/** Moves past the three answer rows to "Looks right" and commits. */
async function confirmReview(stdin: { write: (s: string) => void }) {
  for (let i = 0; i < 3; i++) await type(stdin, ARROW_DOWN);
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
    expect(frame).toContain('Looks right');
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
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('Looks right');

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
});
