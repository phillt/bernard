import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { TextInputOverlay } from '../overlays/TextInputOverlay.js';
import { ESC, ENTER, BACKSPACE, CTRL_C, CTRL_J, META_ENTER, ARROW_LEFT, tick } from './_keys.js';
import { HINT_DIVIDER } from '../hints.js';
import stripAnsi from 'strip-ansi';

describe('<TextInputOverlay>', () => {
  it('renders label, initial value, and the commit hint', () => {
    const { lastFrame } = render(
      createElement(TextInputOverlay, {
        options: { label: 'New profile name', initialValue: 'staging' },
        onResolve: () => {},
      }),
    );
    // Stripped, because `HintRow` colors the key token separately from its
    // label — the literal substring never appears once ANSI is emitted. Same
    // helper `hints.test.tsx` uses for the same reason.
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('New profile name');
    expect(frame).toContain('staging');
    // Routed through the shared `HintRow` (#354) so the footer picks up theme
    // colors instead of raw `dimColor` — same defect fixed for MenuRow in
    // #320. That brings the shared `HINT_DIVIDER` spacing with it, so the
    // separator is built from the constant rather than spelled out here.
    expect(frame).toContain(`↵ commit${HINT_DIVIDER}esc cancel`);
  });

  it('stacks the label above the input so a long answer can wrap (#354)', () => {
    // As row siblings, label and input were separate flex items and text could
    // not reflow across the boundary — a long answer ran off the right edge.
    // `ask_user` passes a model-written question as the label, which is the
    // pathological case.
    const label = 'Which of the following deployment targets should we use for this rollout';
    const { lastFrame } = render(
      createElement(TextInputOverlay, {
        options: { label, initialValue: 'the answer' },
        onResolve: () => {},
      }),
    );
    const lines = (lastFrame() ?? '').split('\n');
    const labelRow = lines.findIndex((l) => l.includes(label.slice(0, 20)));
    const inputRow = lines.findIndex((l) => l.includes('the answer'));
    expect(labelRow).toBeGreaterThanOrEqual(0);
    expect(inputRow).toBeGreaterThan(labelRow);
  });

  it('bounds a long answer vertically, like the prompt (#355)', () => {
    // The overlay shares `useLineEditor` with `Prompt`, so it had the same
    // unbounded growth — measured at 85 rows for an 8k answer inside the same
    // fixed-height modal frame. Reachable because `insert()` strips newlines
    // for single-line editors, so a pasted answer is one long soft-wrapped
    // line. Both now render through `BoundedLine`.
    const { lastFrame } = render(
      createElement(TextInputOverlay, {
        options: { label: 'Answer', initialValue: 'x'.repeat(8000) },
        onResolve: () => {},
      }),
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame.split('\n').length).toBeLessThan(20);
    expect(frame).toContain('▲');
  });

  it('renders placeholder when buffer is empty', () => {
    const { lastFrame } = render(
      createElement(TextInputOverlay, {
        options: { label: 'L', placeholder: 'type here…' },
        onResolve: () => {},
      }),
    );
    expect(lastFrame()).toContain('type here…');
  });

  it('typed characters accumulate and Enter commits trimmed value', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(
      createElement(TextInputOverlay, {
        options: { label: 'L' },
        onResolve,
      }),
    );
    await tick();
    stdin.write('h');
    stdin.write('i');
    stdin.write(' ');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onResolve).toHaveBeenCalledWith({ cancelled: false, raw: 'hi' });
  });

  it('backspace removes the last character', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(
      createElement(TextInputOverlay, {
        options: { label: 'L', initialValue: 'abc' },
        onResolve,
      }),
    );
    await tick();
    stdin.write(BACKSPACE);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onResolve).toHaveBeenCalledWith({ cancelled: false, raw: 'ab' });
  });

  it('Esc and Ctrl-C cancel', async () => {
    for (const keystroke of [ESC, CTRL_C]) {
      const onResolve = vi.fn();
      const { stdin } = render(
        createElement(TextInputOverlay, {
          options: { label: 'L', initialValue: 'x' },
          onResolve,
        }),
      );
      await tick();
      stdin.write(keystroke);
      await tick();
      expect(onResolve).toHaveBeenCalledWith({ cancelled: true });
    }
  });

  it('empty Enter cancels by default (cancelOnEmpty)', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(
      createElement(TextInputOverlay, {
        options: { label: 'L' },
        onResolve,
      }),
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onResolve).toHaveBeenCalledWith({ cancelled: true });
  });

  it('empty Enter commits empty string when cancelOnEmpty: false', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(
      createElement(TextInputOverlay, {
        options: { label: 'L', cancelOnEmpty: false },
        onResolve,
      }),
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onResolve).toHaveBeenCalledWith({ cancelled: false, raw: '' });
  });

  it('left arrow moves the cursor so typing inserts mid-string', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(
      createElement(TextInputOverlay, {
        options: { label: 'L', initialValue: 'abc' },
        onResolve,
      }),
    );
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write('X');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onResolve).toHaveBeenCalledWith({ cancelled: false, raw: 'abXc' });
  });

  it('backspace deletes the character before the cursor', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(
      createElement(TextInputOverlay, {
        options: { label: 'L', initialValue: 'abc' },
        onResolve,
      }),
    );
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(BACKSPACE);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onResolve).toHaveBeenCalledWith({ cancelled: false, raw: 'ac' });
  });

  it('newline-ish keys are stripped — overlay inputs stay single-line', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(
      createElement(TextInputOverlay, {
        options: { label: 'L', initialValue: 'ab' },
        onResolve,
      }),
    );
    await tick();
    stdin.write(CTRL_J);
    await tick();
    stdin.write(META_ENTER);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onResolve).toHaveBeenCalledWith({ cancelled: false, raw: 'ab' });
  });

  it('headerLines render above the label', () => {
    const { lastFrame } = render(
      createElement(TextInputOverlay, {
        options: { label: 'L', headerLines: ['header line A', 'header line B'] },
        onResolve: () => {},
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('header line A');
    expect(frame).toContain('header line B');
    expect(frame.indexOf('header line A')).toBeLessThan(frame.indexOf('L:'));
  });
});
