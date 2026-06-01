import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { SlashHints, SLASH_COMMANDS } from '../SlashHints.js';

describe('<SlashHints>', () => {
  it('renders nothing when buffer does not start with /', () => {
    const { lastFrame } = render(createElement(SlashHints, { buffer: 'hello' }));
    expect(lastFrame()).toBe('');
  });

  it('renders all commands for an empty / buffer', () => {
    const { lastFrame } = render(createElement(SlashHints, { buffer: '/' }));
    const frame = lastFrame() ?? '';
    for (const cmd of SLASH_COMMANDS) {
      expect(frame).toContain(cmd.name);
    }
  });

  it('filters by prefix as the user types', () => {
    const { lastFrame } = render(createElement(SlashHints, { buffer: '/ex' }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/exit');
    expect(frame).not.toContain('/clear');
  });

  it('renders nothing when no command matches the prefix', () => {
    const { lastFrame } = render(createElement(SlashHints, { buffer: '/nope' }));
    expect(lastFrame()).toBe('');
  });

  it('matching is case-insensitive', () => {
    const { lastFrame } = render(createElement(SlashHints, { buffer: '/EX' }));
    expect(lastFrame()).toContain('/exit');
  });
});
