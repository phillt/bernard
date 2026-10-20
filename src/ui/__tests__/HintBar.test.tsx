import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { HintBar } from '../HintBar.js';

const base = {
  busy: false,
  overlayActive: false,
  slashActive: false,
  pendingMessage: false,
  remoteMode: 'ask' as const,
};

describe('<HintBar> talk mode', () => {
  it('says the mic is open, ahead of everything but an overlay, busy or not', () => {
    for (const busy of [false, true]) {
      const frame = render(
        createElement(HintBar, { ...base, busy, talkState: 'listening' }),
      ).lastFrame()!;
      expect(frame).toContain('listening');
      expect(frame).toContain('stop talking');
      expect(frame).not.toContain('commands');
    }
  });

  it('names each phase', () => {
    for (const s of ['transcribing', 'thinking', 'speaking'] as const) {
      expect(render(createElement(HintBar, { ...base, talkState: s })).lastFrame()).toContain(s);
    }
  });

  it('says nothing about talking when the mode is off', () => {
    const frame = render(createElement(HintBar, { ...base, talkState: null })).lastFrame()!;
    expect(frame).not.toContain('stop talking');
  });
});
