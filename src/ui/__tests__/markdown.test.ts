import { describe, it, expect } from 'vitest';
import stripAnsi from 'strip-ansi';
import { renderMarkdown, healStreamMarkdown, normalizeColor } from '../markdown.js';
import type { ThemeColors } from '../../theme.js';

// Mirrors the `bernard` theme shape: hex accent, named ANSI colors elsewhere.
const COLORS: ThemeColors = {
  accent: '#f97316',
  muted: 'gray',
  text: 'white',
  toolCall: 'yellow',
  error: 'red',
  success: 'green',
  warning: 'yellow',
  prefixColors: ['magenta', 'blue', 'green', 'yellow'],
};

const WIDTH = 80;

describe('renderMarkdown', () => {
  it('keeps plain prose content intact', () => {
    const out = renderMarkdown('just a plain sentence', WIDTH, COLORS);
    expect(stripAnsi(out)).toContain('just a plain sentence');
  });

  it('renders a heading without the # prefix and with ANSI styling', () => {
    const out = renderMarkdown('# My Heading', WIDTH, COLORS);
    expect(stripAnsi(out)).toContain('My Heading');
    expect(stripAnsi(out)).not.toContain('#');
    expect(out).toContain('['); // styled
  });

  it('renders bold without literal asterisks', () => {
    const out = renderMarkdown('some **bold text** here', WIDTH, COLORS);
    expect(stripAnsi(out)).toContain('bold text');
    expect(stripAnsi(out)).not.toContain('**');
    expect(out).toContain('[1m'); // bold escape
  });

  it('renders inline code without backticks and with color', () => {
    const out = renderMarkdown('run `npm test` now', WIDTH, COLORS);
    expect(stripAnsi(out)).toContain('npm test');
    expect(stripAnsi(out)).not.toContain('`');
    expect(out).toContain('[33m'); // yellow (toolCall)
  });

  it('renders list items with bullets', () => {
    const out = stripAnsi(renderMarkdown('- one\n- two', WIDTH, COLORS));
    expect(out).toContain('one');
    expect(out).toContain('two');
    expect(out).not.toContain('- one');
  });

  it('renders inline markdown inside tight list items (marked-terminal text-token bug)', () => {
    const out = renderMarkdown('- **Ken Outly** — active thread\n- plain item', WIDTH, COLORS);
    expect(stripAnsi(out)).toContain('Ken Outly');
    expect(stripAnsi(out)).not.toContain('**');
    expect(out).toContain('[1m'); // bold applied inside the list item
  });

  it('renders links inside list items', () => {
    const out = renderMarkdown('- see [docs](https://example.com)', WIDTH, COLORS);
    const plain = stripAnsi(out);
    expect(plain).toContain('docs');
    expect(plain).not.toContain('[docs]');
  });

  it('renders email autolinks without a redundant mailto echo', () => {
    const out = stripAnsi(renderMarkdown('- **Ken <ken@example.com>** wrote', WIDTH, COLORS));
    expect(out).toContain('ken@example.com');
    expect(out).not.toContain('mailto:');
  });

  it('returns empty input unchanged', () => {
    expect(renderMarkdown('', WIDTH, COLORS)).toBe('');
  });

  it('returns whitespace-only input unchanged', () => {
    expect(renderMarkdown('   ', WIDTH, COLORS)).toBe('   ');
  });

  it('trims trailing newlines from the rendered output', () => {
    const out = renderMarkdown('a paragraph', WIDTH, COLORS);
    expect(out.endsWith('\n')).toBe(false);
  });

  it('serves identical input from the one-slot cache', () => {
    const a = renderMarkdown('cache me **please**', WIDTH, COLORS);
    const b = renderMarkdown('cache me **please**', WIDTH, COLORS);
    expect(b).toBe(a);
  });
});

describe('healStreamMarkdown', () => {
  it('closes an unterminated bold span', () => {
    expect(healStreamMarkdown('some **partial')).toBe('some **partial**');
  });

  it('closes an unterminated inline code span', () => {
    expect(healStreamMarkdown('run `npm te')).toBe('run `npm te`');
  });

  it('passes empty input through without error', () => {
    expect(healStreamMarkdown('')).toBe('');
  });

  it('leaves complete markdown untouched', () => {
    expect(healStreamMarkdown('all **done** here')).toBe('all **done** here');
  });
});

describe('normalizeColor', () => {
  it('styles via hex strings', () => {
    const out = normalizeColor('#f97316')('x');
    expect(out).toContain('[');
    expect(stripAnsi(out)).toBe('x');
  });

  it('styles via named ANSI colors', () => {
    const out = normalizeColor('whiteBright')('x');
    expect(out).toContain('[');
    expect(stripAnsi(out)).toBe('x');
  });

  it('falls back without throwing on unknown names', () => {
    expect(() => normalizeColor('not-a-color')('x')).not.toThrow();
    expect(stripAnsi(normalizeColor('not-a-color')('x'))).toBe('x');
  });
});
