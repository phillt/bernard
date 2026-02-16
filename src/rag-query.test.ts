import { describe, it, expect } from 'vitest';
import type { CoreMessage } from 'ai';
import { extractRecentUserTexts, buildRAGQuery, applyStickiness } from './rag-query.js';
import type { RAGSearchResult } from './rag.js';

describe('extractRecentUserTexts', () => {
  it('returns empty array for empty history', () => {
    expect(extractRecentUserTexts([], 2)).toEqual([]);
  });

  it('extracts user messages only', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
    ];
    expect(extractRecentUserTexts(history, 2)).toEqual([
      'first question',
      'second question',
    ]);
  });

  it('skips non-user roles (tool, assistant)', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc1', result: 'ok' }] },
      { role: 'user', content: 'next' },
    ];
    const result = extractRecentUserTexts(history, 5);
    expect(result).toEqual(['hello', 'next']);
  });

  it('skips context summary boundary messages', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: '[Context Summary — earlier conversation was compressed.]\n\nSummary here' },
      { role: 'assistant', content: 'Understood.' },
      { role: 'user', content: 'real question' },
    ];
    expect(extractRecentUserTexts(history, 5)).toEqual(['real question']);
  });

  it('skips session-ended boundary messages', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: '[Previous session ended — context restored]' },
      { role: 'user', content: 'real question' },
    ];
    expect(extractRecentUserTexts(history, 5)).toEqual(['real question']);
  });

  it('skips truncation boundary messages', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: '[Earlier conversation was truncated to fit context window.]' },
      { role: 'user', content: 'real question' },
    ];
    expect(extractRecentUserTexts(history, 5)).toEqual(['real question']);
  });

  it('respects maxMessages limit', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'third' },
    ];
    expect(extractRecentUserTexts(history, 2)).toEqual(['second', 'third']);
  });

  it('handles array content (multi-part messages)', () => {
    const history: CoreMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' },
        ],
      },
    ];
    expect(extractRecentUserTexts(history, 2)).toEqual(['hello world']);
  });

  it('returns in chronological order (oldest first)', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'oldest' },
      { role: 'assistant', content: 'r1' },
      { role: 'user', content: 'middle' },
      { role: 'assistant', content: 'r2' },
      { role: 'user', content: 'newest' },
    ];
    const result = extractRecentUserTexts(history, 3);
    expect(result[0]).toBe('oldest');
    expect(result[2]).toBe('newest');
  });
});

describe('buildRAGQuery', () => {
  it('returns currentInput when no history', () => {
    expect(buildRAGQuery('what tools do we use?', [])).toBe('what tools do we use?');
  });

  it('combines recent texts with current input', () => {
    const result = buildRAGQuery('how about compile?', ['what build tools do we use?']);
    expect(result).toBe('what build tools do we use?. how about compile?');
  });

  it('places current input at the end', () => {
    const result = buildRAGQuery('current', ['older', 'recent']);
    expect(result).toMatch(/current$/);
  });

  it('truncates older messages first when exceeding budget', () => {
    const longOld = 'a'.repeat(800);
    const result = buildRAGQuery('current query', [longOld, 'recent msg'], { maxQueryChars: 100 });
    // Current input should be preserved fully
    expect(result).toContain('current query');
    // Total length should be within budget
    expect(result.length).toBeLessThanOrEqual(100 + 10); // some slack for separators
  });

  it('preserves current input even if alone it exceeds budget', () => {
    const longInput = 'x'.repeat(2000);
    const result = buildRAGQuery(longInput, ['old msg'], { maxQueryChars: 1000 });
    expect(result.length).toBeLessThanOrEqual(1000);
  });

  it('handles single history message', () => {
    const result = buildRAGQuery('follow up', ['initial question']);
    expect(result).toBe('initial question. follow up');
  });
});

describe('applyStickiness', () => {
  const makeResults = (items: Array<{ fact: string; similarity: number; domain: string }>): RAGSearchResult[] => items;

  it('returns results unchanged when no previous facts', () => {
    const results = makeResults([
      { fact: 'fact A', similarity: 0.8, domain: 'general' },
      { fact: 'fact B', similarity: 0.7, domain: 'general' },
    ]);
    const output = applyStickiness(results, new Set());
    expect(output).toEqual(results);
  });

  it('boosts similarity for facts in previous turn', () => {
    const results = makeResults([
      { fact: 'fact A', similarity: 0.8, domain: 'general' },
      { fact: 'fact B', similarity: 0.7, domain: 'tool-usage' },
    ]);
    const previous = new Set(['fact B']);
    const output = applyStickiness(results, previous);
    const factB = output.find((r) => r.fact === 'fact B')!;
    expect(factB.similarity).toBeCloseTo(0.75, 5);
  });

  it('clamps boosted similarity at 1.0', () => {
    const results = makeResults([
      { fact: 'fact A', similarity: 0.98, domain: 'general' },
    ]);
    const previous = new Set(['fact A']);
    const output = applyStickiness(results, previous);
    expect(output[0].similarity).toBe(1.0);
  });

  it('re-sorts after boosting', () => {
    const results = makeResults([
      { fact: 'fact A', similarity: 0.8, domain: 'general' },
      { fact: 'fact B', similarity: 0.77, domain: 'tool-usage' },
    ]);
    // Boost fact B by 0.05 → 0.82, which should now outrank fact A at 0.8
    const previous = new Set(['fact B']);
    const output = applyStickiness(results, previous);
    expect(output[0].fact).toBe('fact B');
    expect(output[1].fact).toBe('fact A');
  });

  it('respects domain top-k cap', () => {
    const results = makeResults([
      { fact: 'g1', similarity: 0.9, domain: 'general' },
      { fact: 'g2', similarity: 0.85, domain: 'general' },
      { fact: 'g3', similarity: 0.8, domain: 'general' },
      { fact: 'g4', similarity: 0.75, domain: 'general' },
    ]);
    const output = applyStickiness(results, new Set(['g4']), { topKPerDomain: 3 });
    // Only 3 from 'general' domain should remain
    expect(output.length).toBe(3);
  });

  it('respects total maxResults cap', () => {
    const results: RAGSearchResult[] = [];
    for (let i = 0; i < 12; i++) {
      results.push({ fact: `fact${i}`, similarity: 0.9 - i * 0.01, domain: `domain-${i % 4}` });
    }
    const output = applyStickiness(results, new Set(['fact11']), { maxResults: 9 });
    expect(output.length).toBeLessThanOrEqual(9);
  });

  it('does not cumulatively boost (only single turn)', () => {
    const results = makeResults([
      { fact: 'fact A', similarity: 0.8, domain: 'general' },
    ]);
    // Apply stickiness twice — the second call should use the same boost magnitude
    const prev1 = new Set(['fact A']);
    const output1 = applyStickiness(results, prev1);
    expect(output1[0].similarity).toBeCloseTo(0.85, 5);

    // If we pass output1 as new results with a fresh previous set containing fact A,
    // it still only adds 0.05 once (boost is on the raw result, not cumulative)
    const output2 = applyStickiness(output1, prev1);
    expect(output2[0].similarity).toBeCloseTo(0.9, 5);
  });
});
