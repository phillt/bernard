import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { Prompt } from '../Prompt.js';
import {
  ENTER,
  BACKSPACE,
  ARROW_UP,
  ARROW_DOWN,
  ARROW_LEFT,
  ARROW_RIGHT,
  CTRL_A,
  CTRL_E,
  CTRL_J,
  SHIFT_ENTER_CSIU,
  META_ENTER,
  tick,
} from './_keys.js';

const TAB = '\t';

describe('<Prompt>', () => {
  it('echoes typed characters into the buffer', async () => {
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit: () => {} }));
    await tick();
    stdin.write('hello');
    await tick();
    expect(lastFrame()).toContain('hello');
  });

  it('submits the trimmed buffer on Enter and clears it', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('  hi  ');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hi');
    // Buffer cleared after submit.
    expect(lastFrame()).not.toContain('hi');
  });

  it('rejects an empty Enter silently', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('backspace removes the last character', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('abc');
    await tick();
    stdin.write(BACKSPACE);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('ab');
  });

  it('is inert when disabled', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { disabled: true, onSubmit }));
    await tick();
    stdin.write('hello');
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders SlashHints when buffer starts with /', async () => {
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit: () => {} }));
    await tick();
    stdin.write('/ex');
    await tick();
    expect(lastFrame()).toContain('/exit');
  });

  it('Enter picks the highlighted slash command instead of the literal buffer', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('/ex');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/exit');
  });

  it('Down arrow moves the slash-command selection', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('/');
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    // First match is /help; one ArrowDown lands on /clear.
    expect(onSubmit).toHaveBeenCalledWith('/clear');
  });

  it('Tab autocompletes the highlighted command into the buffer', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('/ta');
    await tick();
    stdin.write(TAB);
    await tick();
    expect(lastFrame()).toContain('/task ');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('left arrow moves the cursor so typing inserts mid-string', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('abc');
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write('X');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('abXc');
  });

  it('backspace deletes the character before the cursor', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('abc');
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(BACKSPACE);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('bc');
  });

  it('left at position 0 and right at the end are no-ops', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('ab');
    await tick();
    // Walk well past both boundaries.
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(ARROW_RIGHT);
    await tick();
    stdin.write(ARROW_RIGHT);
    await tick();
    stdin.write(ARROW_RIGHT);
    await tick();
    stdin.write('!');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('ab!');
  });

  it('Ctrl-A jumps to start, Ctrl-E back to end', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('world');
    await tick();
    stdin.write(CTRL_A);
    await tick();
    stdin.write('hi ');
    await tick();
    stdin.write(CTRL_E);
    await tick();
    stdin.write('!');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hi world!');
  });

  it('Ctrl+J inserts a newline; Enter submits the multi-line message', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('line1');
    await tick();
    stdin.write(CTRL_J);
    await tick();
    stdin.write('line2');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('line1\nline2');
  });

  it('CSI-u Shift+Enter (kitty) inserts a newline instead of submitting', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('a');
    await tick();
    stdin.write(SHIFT_ENTER_CSIU);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write('b');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('a\nb');
  });

  it('ESC+CR (iTerm2/VS Code Shift+Enter) inserts a newline instead of submitting', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('a');
    await tick();
    stdin.write(META_ENTER);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write('b');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('a\nb');
  });

  it('trailing backslash + Enter continues the line instead of submitting', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(createElement(Prompt, { onSubmit }));
    await tick();
    stdin.write('first\\');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write('second');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('first\nsecond');
  });

  it('renders a multi-line buffer across lines', async () => {
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit: () => {} }));
    await tick();
    stdin.write('alpha');
    await tick();
    stdin.write(CTRL_J);
    await tick();
    stdin.write('omega');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('alpha');
    expect(frame).toContain('omega');
    // The two halves are on different rows.
    const alphaLine = frame.split('\n').findIndex((l) => l.includes('alpha'));
    const omegaLine = frame.split('\n').findIndex((l) => l.includes('omega'));
    expect(alphaLine).toBeGreaterThanOrEqual(0);
    expect(omegaLine).toBeGreaterThan(alphaLine);
  });

  it('renders the buffer split around a mid-string cursor', async () => {
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit: () => {} }));
    await tick();
    stdin.write('abc');
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    // The full text is still present; the end-of-line block glyph is not,
    // because the cursor now sits on 'c' (rendered inverse).
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ab');
    expect(frame).toContain('c');
    expect(frame).not.toContain('▌');
  });
});

describe('<Prompt> input history (↑/↓ recall)', () => {
  // Wire up history like App does: a stable array the Prompt reads live, pushed
  // to (deduped) on each submit.
  function renderWithHistory(seed: string[] = []) {
    const history = [...seed];
    const onRecordInput = (t: string) => {
      if (history[history.length - 1] !== t) history.push(t);
    };
    const onSubmit = vi.fn();
    const utils = render(createElement(Prompt, { onSubmit, history, onRecordInput }));
    return { ...utils, history, onSubmit };
  }

  it('records submissions and recalls them with ↑, walking newer with ↓', async () => {
    const { stdin, lastFrame, history } = renderWithHistory();
    await tick();
    stdin.write('first');
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write('second');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(history).toEqual(['first', 'second']);

    // ↑ on the (now empty) buffer recalls the most recent submission.
    stdin.write(ARROW_UP);
    await tick();
    expect(lastFrame()).toContain('second');
    // ↑ again → older.
    stdin.write(ARROW_UP);
    await tick();
    expect(lastFrame()).toContain('first');
    // ↓ → newer.
    stdin.write(ARROW_DOWN);
    await tick();
    expect(lastFrame()).toContain('second');
    // ↓ past the newest → back to an empty buffer.
    stdin.write(ARROW_DOWN);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('second');
    expect(frame).not.toContain('first');
  });

  it('recall survives without a completed turn (recorded at submit time)', async () => {
    // onSubmit is a no-op spy here — the turn never "runs" — yet ↑ still recalls,
    // mirroring "I hit interrupt and the prompt was still there".
    const { stdin, lastFrame } = renderWithHistory();
    await tick();
    stdin.write('do the thing');
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(ARROW_UP);
    await tick();
    expect(lastFrame()).toContain('do the thing');
  });

  it('keeps walking history even when a recalled line is a slash command', async () => {
    const { stdin, lastFrame } = renderWithHistory(['hello there', '/specialists']);
    await tick();
    stdin.write(ARROW_UP); // most recent → /specialists
    await tick();
    expect(lastFrame()).toContain('/specialists');
    stdin.write(ARROW_UP); // older → hello there (history wins over slash-hint nav)
    await tick();
    expect(lastFrame()).toContain('hello there');
  });

  it('does nothing on ↑ when there is no history', async () => {
    const { stdin, lastFrame } = renderWithHistory();
    await tick();
    stdin.write(ARROW_UP);
    await tick();
    // Empty buffer, just the cursor glyph — no crash, nothing recalled.
    expect(lastFrame()).toContain('▌');
  });
});

describe('<Prompt> dynamic slash commands (routines/tasks)', () => {
  it('autocompletes saved routines from dynamicCommands and submits the picked one', async () => {
    const onSubmit = vi.fn();
    const dynamicCommands = () => [
      { name: '/morning-triage', description: 'routine · Morning triage' },
    ];
    const { stdin, lastFrame } = render(createElement(Prompt, { onSubmit, dynamicCommands }));
    await tick();
    stdin.write('/morn');
    await tick();
    // The routine shows in the hint strip…
    expect(lastFrame()).toContain('/morning-triage');
    // …and Enter submits it (same path the dynamic `/<id>` dispatch uses).
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/morning-triage');
  });
});
