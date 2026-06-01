import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { HelpOverlay } from '../overlays/HelpOverlay.js';
import { ESC, ENTER, tick } from './_keys.js';

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
    expect(frame).toContain('Enter / Esc / q to close');
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
