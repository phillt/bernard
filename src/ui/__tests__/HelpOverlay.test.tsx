import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { HelpOverlay } from '../overlays/HelpOverlay.js';
import { SLASH_COMMANDS } from '../SlashHints.js';
import { ESC, ENTER, tick } from './_keys.js';
import stripAnsi from 'strip-ansi';

describe('<HelpOverlay>', () => {
  it('lists every documented slash command', () => {
    const { lastFrame } = render(createElement(HelpOverlay, { onClose: () => {} }));
    const frame = lastFrame() ?? '';
    // Derived from the catalogue, not retyped (#390). The list that stood here
    // was the third copy of it and had gone stale on its own terms — it omitted
    // eight live commands, and its `/model` entry passed only as a SUBSTRING of
    // the rendered `/models`, so it asserted a command the help screen has never
    // shown. A frame-contains check over the source list cannot drift that way.
    for (const cmd of SLASH_COMMANDS) {
      expect(frame).toContain(cmd.name);
      expect(frame).toContain(cmd.detail ?? cmd.description);
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
