import { describe, it, expect } from 'vitest';
import { formatCurrentDateTime, timestampUserMessage, stripTimestamp } from './datetime.js';

describe('formatCurrentDateTime', () => {
  it('contains the current year', () => {
    const result = formatCurrentDateTime();
    expect(result).toContain(new Date().getFullYear().toString());
  });

  it('contains a day of the week', () => {
    const result = formatCurrentDateTime();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    expect(days.some((d) => result.includes(d))).toBe(true);
  });

  it('contains "at" joining date and time', () => {
    expect(formatCurrentDateTime()).toContain(' at ');
  });

  it('contains a time pattern', () => {
    expect(formatCurrentDateTime()).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('timestampUserMessage', () => {
  it('prefixes input with a bracketed ISO 8601 timestamp', () => {
    const result = timestampUserMessage('Hello');
    expect(result).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] Hello$/);
  });

  it('preserves the original user input', () => {
    const input = 'What time is it?';
    const result = timestampUserMessage(input);
    expect(result).toContain(input);
  });

  it('handles empty input', () => {
    const result = timestampUserMessage('');
    expect(result).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] $/);
  });

  it('handles input containing brackets', () => {
    const result = timestampUserMessage('[test] message');
    expect(result).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] \[test\] message$/,
    );
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
