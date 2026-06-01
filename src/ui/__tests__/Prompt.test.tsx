import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { Prompt } from '../Prompt.js';
import { ENTER, BACKSPACE, tick } from './_keys.js';

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
});
