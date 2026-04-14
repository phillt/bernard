import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatCurrentDateTime,
  timestampUserMessage,
  timestampUserContent,
  stripTimestamp,
} from './datetime.js';

const FIXED_DATE = new Date('2025-06-15T14:30:00-04:00');

describe('formatCurrentDateTime', () => {
  afterEach(() => vi.useRealTimers());

  it('contains the current year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
    const result = formatCurrentDateTime();
    expect(result).toContain('2025');
  });

  it('contains a day of the week', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
    const result = formatCurrentDateTime();
    expect(result).toContain('Sunday');
  });

  it('contains "at" joining date and time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
    expect(formatCurrentDateTime()).toContain(' at ');
  });

  it('contains a time pattern', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
    expect(formatCurrentDateTime()).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('timestampUserMessage', () => {
  afterEach(() => vi.useRealTimers());

  it('prefixes input with a bracketed ISO 8601 timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
    const result = timestampUserMessage('Hello');
    expect(result).toMatch(/^\[2025-06-15T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] Hello$/);
  });

  it('preserves the original user input', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
    const input = 'What time is it?';
    const result = timestampUserMessage(input);
    expect(result).toContain(input);
  });

  it('handles empty input', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
    const result = timestampUserMessage('');
    expect(result).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] $/);
  });

  it('handles input containing brackets', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
    const result = timestampUserMessage('[test] message');
    expect(result).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] \[test\] message$/,
    );
  });
});

describe('timestampUserContent', () => {
  afterEach(() => vi.useRealTimers());

  it('delegates to timestampUserMessage for string input', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
    const result = timestampUserContent('Hello');
    expect(typeof result).toBe('string');
    expect(result).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] Hello$/);
  });

  it('prepends timestamp to first text part in array', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
    const input = [
      { type: 'text' as const, text: 'Describe this' },
      { type: 'image' as const, image: Buffer.from('data'), mimeType: 'image/png' },
    ];
    const result = timestampUserContent(input);
    expect(Array.isArray(result)).toBe(true);
    const parts = result as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] Describe this$/,
    );
    expect(parts[1].type).toBe('image');
  });

  it('inserts text part when array has no text parts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
    const input = [{ type: 'image' as const, image: Buffer.from('data'), mimeType: 'image/png' }];
    const result = timestampUserContent(input);
    const parts = result as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]$/);
    expect(parts[1].type).toBe('image');
  });

  it('does not mutate the original array', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
    const original = [
      { type: 'text' as const, text: 'original text' },
      { type: 'image' as const, image: Buffer.from('data'), mimeType: 'image/png' },
    ];
    const originalText = original[0].text;
    timestampUserContent(original);
    expect(original[0].text).toBe(originalText);
    expect(original).toHaveLength(2);
  });
});

describe('stripTimestamp', () => {
  it('strips a valid ISO timestamp prefix', () => {
    expect(stripTimestamp('[2025-03-27T14:30:00-04:00] hello')).toBe('hello');
  });

  it('strips a UTC+ offset timestamp', () => {
    expect(stripTimestamp('[2025-03-27T14:30:00+05:30] hello')).toBe('hello');
  });

  it('returns plain text unchanged', () => {
    expect(stripTimestamp('hello')).toBe('hello');
  });

  it('does not strip non-ISO bracket content', () => {
    expect(stripTimestamp('[not a timestamp] hello')).toBe('[not a timestamp] hello');
  });

  it('handles empty string', () => {
    expect(stripTimestamp('')).toBe('');
  });
});
