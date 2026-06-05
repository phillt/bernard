import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { TextInputOverlay } from '../overlays/TextInputOverlay.js';
import { ESC, ENTER, BACKSPACE, CTRL_C, ARROW_LEFT, tick } from './_keys.js';

describe('<TextInputOverlay>', () => {
  it('renders label, initial value, and the commit hint', () => {
    const { lastFrame } = render(
      createElement(TextInputOverlay, {
        options: { label: 'New profile name', initialValue: 'staging' },
        onResolve: () => {},
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('New profile name');
    expect(frame).toContain('staging');
    expect(frame).toContain('Enter commit · Esc cancel');
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
