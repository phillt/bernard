import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { DimensionsProvider } from '../DimensionsContext.js';
import { WizardOverlay } from '../overlays/WizardOverlay.js';
import { stepsFromQuestions } from '../overlays/wizard-types.js';
import type { StepCheckResult, WizardResult, WizardSpec } from '../overlays/wizard-types.js';
import { ENTER, ARROW_DOWN, ARROW_LEFT, ARROW_RIGHT, CTRL_T, tick, frameRows } from './_keys.js';

/** Terminal size, so one case can shrink the card below the control's floor. */
const SIZE = vi.hoisted(() => ({ columns: 100, rows: 24 }));
vi.mock('../useDimensions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../useDimensions.js')>();
  return { ...actual, useDimensions: () => SIZE };
});

/**
 * The optional "test this key" control (#447).
 *
 * The property the whole design rests on is that the verdict is INERT: it is
 * shown and then forgotten. Nothing about it reaches `WizardState`, so Save
 * behaves identically whether the key was tested, failed the test, or the
 * network was down. Every assertion here is either that property or the
 * lifetime rules that keep a stale verdict off the screen.
 */

/** A check whose promise this test resolves by hand, so the busy state is observable. */
function deferredCheck() {
  let settle: (r: StepCheckResult) => void = () => {};
  const seen: Array<{ answer: string; signal: AbortSignal }> = [];
  const run = vi.fn((answer: string, signal: AbortSignal) => {
    seen.push({ answer, signal });
    return new Promise<StepCheckResult>((resolve) => {
      settle = resolve;
    });
  });
  return {
    run,
    seen,
    resolve: async (r: StepCheckResult) => {
      settle(r);
      await tick(20);
    },
  };
}

function specWith(check?: WizardSpec['steps'][number]['check']): WizardSpec {
  return {
    skipReview: true,
    steps: [
      {
        id: 'key:anthropic',
        question: 'API key for anthropic',
        field: { kind: 'text' },
        optional: true,
        ...(check === undefined ? {} : { check }),
      },
    ],
  };
}

beforeEach(() => {
  SIZE.columns = 100;
});

async function mount(spec: WizardSpec) {
  const onResolve = vi.fn<[WizardResult], void>();
  const harness = render(
    createElement(DimensionsProvider, null, createElement(WizardOverlay, { spec, onResolve })),
  );
  await tick();
  const frame = () => stripAnsi(harness.lastFrame() ?? '');
  return { ...harness, onResolve, frame };
}

/** The control is one `↓` from the buffer and one `←` along the row. */
async function focusCheck(stdin: { write: (s: string) => void }) {
  stdin.write(ARROW_DOWN);
  await tick();
  stdin.write(ARROW_LEFT);
  await tick();
}

describe('the key page can test the key, optionally', () => {
  it('shows the busy label while the check runs, and the verdict after', async () => {
    const check = deferredCheck();
    const { stdin, frame } = await mount(
      specWith({ label: 'Test key', busyLabel: 'Testing…', run: check.run }),
    );
    expect(frame()).toContain('Test key');

    await focusCheck(stdin);
    stdin.write(ENTER);
    await tick();
    expect(frame()).toContain('Testing…');
    expect(frame()).not.toContain('Test key');

    await check.resolve({ tone: 'ok', message: 'Key is valid' });
    expect(frame()).toContain('Key is valid');
    // …and the label comes back, so the control is usable again.
    expect(frame()).toContain('Test key');
  });

  it('keeps the frame exactly as tall before, during and after', async () => {
    // The reserved row is what buys this: a message row that appeared only when
    // there was something to say would reflow the card under a reader who is
    // mid-correction, which is `OverlayFooter`'s rule.
    const check = deferredCheck();
    const { stdin, lastFrame } = await mount(
      specWith({ label: 'Test key', busyLabel: 'Testing…', run: check.run }),
    );
    const before = frameRows(lastFrame());
    await focusCheck(stdin);
    stdin.write(ENTER);
    await tick();
    const during = frameRows(lastFrame());
    await check.resolve({ tone: 'bad', message: 'Key rejected' });
    expect([during, frameRows(lastFrame())]).toEqual([before, before]);
  });

  it('runs once when Enter is pressed twice', async () => {
    // A second press while one is in flight is ignored rather than restarting:
    // the label already reads the busy word, so a no-op is legible, and
    // aborting to start again would only double the requests.
    const check = deferredCheck();
    const { stdin } = await mount(
      specWith({ label: 'Test key', busyLabel: 'Testing…', run: check.run }),
    );
    await focusCheck(stdin);
    stdin.write(ENTER);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(check.run).toHaveBeenCalledTimes(1);
  });

  it('aborts the probe when the step goes away mid-flight', async () => {
    // Required rather than hygiene: a step remounts on every navigation, so
    // without the cleanup an Esc or a Back mid-probe leaves a socket open for
    // the whole timeout — and hangs a runner that waits for the process to go
    // quiet. Asserted on the UNMOUNT rather than on the Esc keystroke, because
    // dismissal resolves the overlay and it is the host that then takes the
    // tree down; a test that pressed Esc and stopped there would pass while the
    // cleanup was deleted.
    const check = deferredCheck();
    const { stdin, unmount } = await mount(
      specWith({ label: 'Test key', busyLabel: 'Testing…', run: check.run }),
    );
    await focusCheck(stdin);
    stdin.write(ENTER);
    await tick();
    expect(check.seen[0].signal.aborted).toBe(false);
    unmount();
    await tick();
    expect(check.seen[0].signal.aborted).toBe(true);
  });

  it('forgets a verdict as soon as the buffer changes', async () => {
    // The worst thing this page could say is a green "Key is valid" beside a
    // key that is no longer the one tested.
    const check = deferredCheck();
    const { stdin, frame } = await mount(
      specWith({ label: 'Test key', busyLabel: 'Testing…', run: check.run }),
    );
    await focusCheck(stdin);
    stdin.write(ENTER);
    await check.resolve({ tone: 'ok', message: 'Key is valid' });
    expect(frame()).toContain('Key is valid');
    stdin.write('x');
    await tick();
    expect(frame()).not.toContain('Key is valid');
  });

  it('never gates the answer on the verdict', async () => {
    // The contract in one assertion: a rejected key still saves, and the result
    // carries no trace of the check having happened at all.
    const check = deferredCheck();
    const { stdin, onResolve } = await mount(
      specWith({ label: 'Test key', busyLabel: 'Testing…', run: check.run }),
    );
    stdin.write('sk-whatever');
    await tick();
    await focusCheck(stdin);
    stdin.write(ENTER);
    await check.resolve({ tone: 'bad', message: 'Key rejected' });
    // Along to the forward control — `→` moves between controls rather than
    // typing, so it cannot clear the verdict on the way.
    stdin.write(ARROW_RIGHT);
    await tick();
    stdin.write(ENTER);
    await tick(20);
    expect(onResolve).toHaveBeenCalledTimes(1);
    const result = onResolve.mock.calls[0][0];
    expect(result.cancelled).toBe(false);
    if (result.cancelled) return;
    expect(result.answers).toEqual(['sk-whatever']);
  });

  it('tests the stored key from an empty buffer', async () => {
    // Blank means "the key already in place", which is the question a reader
    // with one stored actually has. The fallback itself lives on the I/O side;
    // what the page owes is passing the empty string through rather than
    // refusing to run.
    const check = deferredCheck();
    const { stdin } = await mount(
      specWith({ label: 'Test key', busyLabel: 'Testing…', run: check.run }),
    );
    await focusCheck(stdin);
    stdin.write(ENTER);
    await tick();
    expect(check.seen[0].answer).toBe('');
  });

  it('drops the control on a narrow card and names the chord instead', async () => {
    // A control row cannot reflow any more than block lettering can — the rule
    // the rail and the masthead already follow. What makes the drop safe is
    // that `ctrl+t` still fires, and it is advertised in exactly the place the
    // button is missing.
    SIZE.columns = 44;
    const check = deferredCheck();
    const { stdin, frame } = await mount(
      specWith({ label: 'Test key', busyLabel: 'Testing…', run: check.run }),
    );
    expect(frame()).not.toContain('Test key');
    expect(frame()).toContain('ctrl+t');
    stdin.write(CTRL_T);
    await tick();
    expect(check.run).toHaveBeenCalledTimes(1);
  });

  it('leaves the chord out of the hint row wherever the button is drawn', async () => {
    // Two spellings of one action on the row that was already at its budget
    // before this feature. The button is visible, arrow-reachable and carries
    // its own `↵`; the chord still works and simply is not advertised.
    const check = deferredCheck();
    const { stdin, frame } = await mount(
      specWith({ label: 'Test key', busyLabel: 'Testing…', run: check.run }),
    );
    expect(frame()).toContain('Test key');
    expect(frame()).not.toContain('ctrl+t');
    stdin.write(CTRL_T);
    await tick();
    expect(check.run).toHaveBeenCalledTimes(1);
  });

  it('renders a step with no check exactly as it did before', async () => {
    // The regression guard: the third control, the hint and the reserved row
    // are all additions, and every existing step kind has to be untouched.
    const plain = await mount(specWith());
    expect(plain.frame()).not.toContain('Test key');
    expect(plain.frame()).not.toContain('ctrl+t');
    // ↓ still lands on the primary action rather than on a control that is
    // not there.
    plain.stdin.write(ARROW_DOWN);
    await tick();
    expect(plain.frame()).toContain('▸ Skip this');
  });
});

describe('a check is a capability, not data', () => {
  it('is never built from model input', async () => {
    // `ask_user` reaches this overlay through `stepsFromQuestions`, and a check
    // is a network call carrying the user's plaintext secret. There is no key
    // on `AskUserQuestion` to carry one, so this is structurally impossible —
    // which is exactly why it is worth a line that fails if it stops being so.
    const steps = stepsFromQuestions([
      { question: 'Which one?', choices: ['a', 'b'] },
      { question: 'Free text?' },
    ]);
    expect(steps.every((s) => s.check === undefined)).toBe(true);
  });
});
