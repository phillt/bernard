import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { Spinner } from '../Spinner.js';
import { __resetInFlightCalls, beginToolCall } from '../../tools/in-flight.js';

describe('<Spinner>', () => {
  beforeEach(() => {
    __resetInFlightCalls();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetInFlightCalls();
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

  /**
   * #594: a dead MCP server held a turn for 35 minutes and this line said
   * `thinking…` for every one of them. The fact was computed by the runner's
   * watchdog every 30 seconds and thrown into a `debugLog` nobody had enabled.
   */
  it('names a tool call that has been running too long', () => {
    // Start it in the past by moving the clock, not by waiting: the registry
    // stamps `Date.now()` at `beginToolCall`, so this is the only way to make a
    // call old at mount.
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow - 245_000);
    beginToolCall('beeper.send_message');
    clock.mockReturnValue(realNow);

    const { lastFrame } = render(createElement(Spinner, { label: 'thinking…' }));
    expect(lastFrame()).toContain('beeper.send_message 4m5s');
    clock.mockRestore();
  });

  it('says nothing about a call that has only just started', () => {
    // Most tool calls finish inside a few seconds. Naming every one of them
    // would make the line noise and the notice worthless.
    beginToolCall('web_read');
    const { lastFrame } = render(createElement(Spinner, { label: 'thinking…' }));
    expect(lastFrame()).not.toContain('web_read');
  });
});
