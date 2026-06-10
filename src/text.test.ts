import { describe, it, expect } from 'vitest';
import { truncate } from './text.js';

describe('truncate', () => {
  it('returns the string unchanged when it fits', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });
  it('caps at max with a single-char ellipsis and no trailing space', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
    expect(truncate('hello world', 7)).toBe('hello…'); // trailing space trimmed before the ellipsis
  });
});
