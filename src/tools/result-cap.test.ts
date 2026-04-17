import { describe, it, expect } from 'vitest';
import {
  capSubagentResult,
  parseSubagentResultMaxChars,
  SUBAGENT_RESULT_MAX_CHARS,
  DEFAULT_SUBAGENT_RESULT_MAX_CHARS,
} from './result-cap.js';

describe('capSubagentResult', () => {
  it('returns empty string unchanged', () => {
    expect(capSubagentResult('')).toBe('');
  });

  it('returns text below the cap unchanged', () => {
    const text = 'x'.repeat(100);
    expect(capSubagentResult(text, 200)).toBe(text);
  });

  it('returns text exactly at the cap unchanged', () => {
    const text = 'a'.repeat(50);
    expect(capSubagentResult(text, 50)).toBe(text);
  });

  it('truncates and appends a marker when text exceeds the cap', () => {
    const text = 'b'.repeat(200);
    const cap = 100;
    const capped = capSubagentResult(text, cap);
    const marker = `\n...[output truncated at ${cap} chars]`;
    expect(capped.length).toBe(cap);
    expect(capped.endsWith(marker)).toBe(true);
    expect(capped.startsWith('b'.repeat(cap - marker.length))).toBe(true);
  });

  it('total length never exceeds maxChars', () => {
    const text = 'b'.repeat(10000);
    for (const cap of [50, 100, 500, 4000]) {
      expect(capSubagentResult(text, cap).length).toBeLessThanOrEqual(cap);
    }
  });

  it('returns truncated marker when maxChars is smaller than the marker', () => {
    const text = 'z'.repeat(1000);
    const capped = capSubagentResult(text, 10);
    expect(capped.length).toBe(10);
  });

  it('uses SUBAGENT_RESULT_MAX_CHARS as the default cap', () => {
    const text = 'c'.repeat(SUBAGENT_RESULT_MAX_CHARS + 100);
    const capped = capSubagentResult(text);
    expect(capped).toContain(`[output truncated at ${SUBAGENT_RESULT_MAX_CHARS} chars]`);
    expect(capped.length).toBe(SUBAGENT_RESULT_MAX_CHARS);
  });
});

describe('parseSubagentResultMaxChars', () => {
  it('returns the default when env var is undefined', () => {
    expect(parseSubagentResultMaxChars(undefined)).toBe(DEFAULT_SUBAGENT_RESULT_MAX_CHARS);
  });

  it('returns the default for empty string', () => {
    expect(parseSubagentResultMaxChars('')).toBe(DEFAULT_SUBAGENT_RESULT_MAX_CHARS);
  });

  it('returns the default for non-numeric values', () => {
    expect(parseSubagentResultMaxChars('abc')).toBe(DEFAULT_SUBAGENT_RESULT_MAX_CHARS);
  });

  it('returns the default for zero or negative values', () => {
    expect(parseSubagentResultMaxChars('0')).toBe(DEFAULT_SUBAGENT_RESULT_MAX_CHARS);
    expect(parseSubagentResultMaxChars('-100')).toBe(DEFAULT_SUBAGENT_RESULT_MAX_CHARS);
  });

  it('returns the parsed integer for valid positive input', () => {
    expect(parseSubagentResultMaxChars('8000')).toBe(8000);
    expect(parseSubagentResultMaxChars('1')).toBe(1);
  });

  it('floors fractional input', () => {
    expect(parseSubagentResultMaxChars('1234.9')).toBe(1234);
  });
});
