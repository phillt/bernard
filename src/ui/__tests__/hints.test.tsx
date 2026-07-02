import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import stripAnsi from 'strip-ansi';
import { HintRow, HINT_DIVIDER } from '../hints.js';

describe('HintRow (shared chrome legend)', () => {
  it('renders each key + label joined by the dot divider', () => {
    const frame =
      stripAnsi(
        render(
          createElement(HintRow, {
            hints: [
              { key: '↑/↓', label: 'scroll' },
              { key: '⇧⇥', label: 'switch tab' },
              { key: 'esc', label: 'close' },
            ],
          }),
        ).lastFrame() ?? '',
      ) ?? '';
    expect(frame).toBe(`↑/↓ scroll${HINT_DIVIDER}⇧⇥ switch tab${HINT_DIVIDER}esc close`);
  });

  it('renders a single hint with no leading divider', () => {
    const frame = stripAnsi(
      render(createElement(HintRow, { hints: [{ key: 'esc', label: 'interrupt' }] })).lastFrame() ??
        '',
    );
    expect(frame).toBe('esc interrupt');
  });

  it('renders nothing for an empty hint list', () => {
    const frame = stripAnsi(render(createElement(HintRow, { hints: [] })).lastFrame() ?? '');
    expect(frame).toBe('');
  });
});
