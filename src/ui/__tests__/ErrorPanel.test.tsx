import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { ErrorPanel } from '../ErrorPanel.js';
import type { ErrorPanelData } from '../error-format.js';

const DATA: ErrorPanelData = {
  title: 'Rate limit / quota',
  category: 'rate_limit',
  message: 'You exceeded your current quota.',
  hint: 'Rate-limited — wait or switch lineup with /lineups.',
};

describe('<ErrorPanel>', () => {
  it('renders the title, category tag, message and hint in a bordered frame', () => {
    const { lastFrame } = render(createElement(ErrorPanel, { data: DATA }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⚠ Rate limit / quota');
    expect(frame).toContain('· rate_limit');
    expect(frame).toContain('You exceeded your current quota.');
    expect(frame).toContain('→ Rate-limited — wait or switch lineup with /lineups.');
    expect(frame).toMatch(/[╭╮╰╯]/); // rounded border drawn
  });

  it('omits the details block when there are none', () => {
    const { lastFrame } = render(createElement(ErrorPanel, { data: DATA }));
    expect(lastFrame()).not.toContain('Caused by:');
  });

  it('renders the dim details block when present', () => {
    const { lastFrame } = render(
      createElement(ErrorPanel, {
        data: { ...DATA, details: 'Error: boom\nCaused by:\ninner' },
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Error: boom');
    expect(frame).toContain('Caused by:');
  });
});
