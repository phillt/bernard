import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { Spinner } from '../Spinner.js';

describe('<Spinner>', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a braille frame with no label', () => {
    const { lastFrame } = render(createElement(Spinner));
    const frame = lastFrame() ?? '';
    // First frame is ⠋ on mount.
    expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it('renders a label when provided', () => {
    const { lastFrame } = render(createElement(Spinner, { label: 'Thinking (5s | 100↑ 50↓)' }));
    expect(lastFrame()).toContain('Thinking (5s | 100↑ 50↓)');
  });

  it('advances frames on the animation interval', async () => {
    const { lastFrame } = render(createElement(Spinner));
    const before = lastFrame();
    // Drive several intervals so Ink's debounced renderer flushes a new frame
    // (one tick can land inside the same paint cycle as the initial render).
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(80);
    }
    const after = lastFrame();
    expect(after).not.toBe(before);
  });
});
