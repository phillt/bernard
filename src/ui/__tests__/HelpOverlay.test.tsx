import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { HelpOverlay } from '../overlays/HelpOverlay.js';
import { ESC, ENTER, tick } from './_keys.js';
import stripAnsi from 'strip-ansi';

describe('<HelpOverlay>', () => {
  it('lists every documented slash command', () => {
    const { lastFrame } = render(createElement(HelpOverlay, { onClose: () => {} }));
    const frame = lastFrame() ?? '';
    for (const cmd of [
      '/help',
      '/clear',
      '/compact',
      '/task',
      '/image',
      '/memory',
      '/scratch',
      '/mcp',
      '/cron',
      '/facts',
      '/provider',
      '/model',
      '/theme',
      '/routines',
      '/create-routine',
      '/create-task',
      '/specialists',
      '/create-specialist',
      '/candidates',
      '/options',
      '/agent-options',
      '/profiles',
      '/manage-profiles',
      '/update',
      '/exit',
    ]) {
      expect(frame).toContain(cmd);
    }
    expect(frame).toContain('Commands');
    // Was `Enter / Esc / q to close` — a third separator style (` / `) and a
    // third casing. Now the shared `HintRow` vocabulary (#266).
    // One compound entry rather than three rows each saying "close" — the
    // `↑/↓`-style idiom this codebase already uses for multi-key hints.
    expect(stripAnsi(frame)).toContain('↵/esc/q close');
  });

  it('closes on Esc, Enter, and q', async () => {
    for (const keystroke of [ESC, ENTER, 'q']) {
      const onClose = vi.fn();
      const { stdin } = render(createElement(HelpOverlay, { onClose }));
      await tick();
      stdin.write(keystroke);
      await tick();
      expect(onClose).toHaveBeenCalledTimes(1);
    }
  });
});
