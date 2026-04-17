import { describe, it, expect } from 'vitest';
import { capSubagentResult, SUBAGENT_RESULT_MAX_CHARS } from './result-cap.js';

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
    const text = 'b'.repeat(100);
    const capped = capSubagentResult(text, 40);
    expect(capped.startsWith('b'.repeat(40))).toBe(true);
    expect(capped).toContain('[output truncated at 40 chars]');
    expect(capped.length).toBe(40 + '\n...[output truncated at 40 chars]'.length);
  });

  it('uses SUBAGENT_RESULT_MAX_CHARS as the default cap', () => {
    const text = 'c'.repeat(SUBAGENT_RESULT_MAX_CHARS + 100);
    const capped = capSubagentResult(text);
    expect(capped).toContain(`[output truncated at ${SUBAGENT_RESULT_MAX_CHARS} chars]`);
    expect(capped.startsWith('c'.repeat(SUBAGENT_RESULT_MAX_CHARS))).toBe(true);
  });
});
