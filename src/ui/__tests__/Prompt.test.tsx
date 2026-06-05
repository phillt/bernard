import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { Prompt } from '../Prompt.js';
import {
  ENTER,
  BACKSPACE,
  ARROW_DOWN,
  ARROW_LEFT,
  ARROW_RIGHT,
  CTRL_A,
  CTRL_E,
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
