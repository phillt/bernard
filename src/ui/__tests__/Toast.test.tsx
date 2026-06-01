import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { Toast } from '../Toast.js';

describe('<Toast>', () => {
  it('renders message with the info prefix by default', () => {
    const { lastFrame } = render(createElement(Toast, { message: 'hello world' }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello world');
    expect(frame).toContain('ℹ');
  });

  it('uses ✓ for success', () => {
    const { lastFrame } = render(createElement(Toast, { message: 'saved', variant: 'success' }));
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('saved');
  });

  it('uses ! for warning', () => {
    const { lastFrame } = render(createElement(Toast, { message: 'careful', variant: 'warning' }));
    expect(lastFrame()).toContain('!');
    expect(lastFrame()).toContain('careful');
  });

  it('uses ✗ for error', () => {
    const { lastFrame } = render(createElement(Toast, { message: 'oops', variant: 'error' }));
    expect(lastFrame()).toContain('✗');
    expect(lastFrame()).toContain('oops');
  });
});
