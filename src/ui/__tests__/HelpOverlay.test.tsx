import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { HelpOverlay } from '../overlays/HelpOverlay.js';
import { ESC, ENTER, tick, CTRL_C } from './_keys.js';
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
    const plain = stripAnsi(frame);
    expect(plain).toContain('↵ close');
    expect(plain).toContain('esc close');
    expect(plain).toContain('q close');
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

  it('closes on Ctrl-C — the contract key that was silently dropped (#266)', async () => {
    const onClose = vi.fn();
    const { stdin } = render(createElement(HelpOverlay, { onClose }));
    await tick();
    stdin.write(CTRL_C);
    await tick();
    expect(onClose).toHaveBeenCalled();
  });
});
