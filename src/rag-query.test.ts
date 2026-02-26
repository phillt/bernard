import { describe, it, expect } from 'vitest';
import type { CoreMessage } from 'ai';
import {
  extractRecentUserTexts,
  extractRecentToolContext,
  buildRAGQuery,
  applyStickiness,
} from './rag-query.js';
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
    expect(extractRecentUserTexts(history, 2)).toEqual(['first question', 'second question']);
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
      {
        role: 'user',
        content: '[Context Summary — earlier conversation was compressed.]\n\nSummary here',
      },
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

describe('extractRecentToolContext', () => {
  it('returns empty string for empty history', () => {
    expect(extractRecentToolContext([])).toBe('');
  });

  it('returns empty string when no tool calls in history', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'next' },
    ];
    expect(extractRecentToolContext(history)).toBe('');
  });

  it('extracts a single tool call', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'shell',
            args: { command: 'ls -la' },
          },
        ],
      },
    ];
    expect(extractRecentToolContext(history)).toBe('shell(command=ls -la)');
  });

  it('extracts multiple tool calls in chronological order', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'shell',
            args: { command: 'ls' },
          },
        ],
      },
      { role: 'user', content: 'ok' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc2',
            toolName: 'memory',
            args: { action: 'read' },
          },
        ],
      },
    ];
    const result = extractRecentToolContext(history);
    expect(result).toBe('shell(command=ls), memory(action=read)');
  });

  it('respects maxMessages limit', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'shell', args: { command: 'echo 1' } },
        ],
      },
      { role: 'user', content: 'ok' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc2', toolName: 'memory', args: { action: 'read' } },
        ],
      },
      { role: 'user', content: 'ok' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc3',
            toolName: 'web_read',
            args: { url: 'http://example.com' },
          },
        ],
      },
    ];
    // Only scan last 1 assistant message
    const result = extractRecentToolContext(history, 1);
    expect(result).toBe('web_read(url=http://example.com)');
    expect(result).not.toContain('shell');
    expect(result).not.toContain('memory');
  });

  it('truncates to maxChars', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'shell',
            args: { command: 'a very long command string here' },
          },
          {
            type: 'tool-call',
            toolCallId: 'tc2',
            toolName: 'memory',
            args: { action: 'write', key: 'some-key' },
          },
        ],
      },
    ];
    const result = extractRecentToolContext(history, 3, 30);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).toMatch(/\.\.\.$/);
  });

  it('returns chronological order (oldest first)', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'first_tool', args: {} }],
      },
      { role: 'user', content: 'ok' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc2', toolName: 'second_tool', args: {} }],
      },
    ];
    const result = extractRecentToolContext(history);
    expect(result.indexOf('first_tool')).toBeLessThan(result.indexOf('second_tool'));
  });

  it('skips non-assistant messages', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'tc1', result: 'ok' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc2', toolName: 'shell', args: { command: 'pwd' } },
        ],
      },
    ];
    const result = extractRecentToolContext(history);
    expect(result).toBe('shell(command=pwd)');
  });

  it('handles tool call with no args', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'datetime', args: {} }],
      },
    ];
    expect(extractRecentToolContext(history)).toBe('datetime');
  });

  it('preserves intra-message tool call order', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'alpha', args: {} },
          { type: 'tool-call', toolCallId: 'tc2', toolName: 'beta', args: {} },
        ],
      },
    ];
    const result = extractRecentToolContext(history);
    expect(result).toBe('alpha, beta');
  });

  it('returns empty string when maxChars < 3', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'shell', args: { command: 'ls' } },
        ],
      },
    ];
    expect(extractRecentToolContext(history, 3, 2)).toBe('');
  });

  it('truncates long arg values to 60 chars', () => {
    const longValue = 'x'.repeat(100);
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'shell',
            args: { command: longValue },
          },
        ],
      },
    ];
    const result = extractRecentToolContext(history);
    // 57 chars + "..." = 60 chars for the value portion
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(100);
  });
});

describe('buildRAGQuery with toolContext', () => {
  it('includes tool context in the query', () => {
    const result = buildRAGQuery('what happened?', ['earlier question'], {
      toolContext: 'shell(command=ls)',
    });
    expect(result).toContain('[tools: shell(command=ls)]');
    expect(result).toContain('what happened?');
  });

  it('omits tool context when undefined', () => {
    const result = buildRAGQuery('hello', ['prev'], { toolContext: undefined });
    expect(result).not.toContain('[tools:');
  });

  it('omits tool context when empty string is not passed (no toolContext key)', () => {
    const result = buildRAGQuery('hello', ['prev'], {});
    expect(result).not.toContain('[tools:');
  });

  it('places tool context before user texts (lowest priority)', () => {
    const result = buildRAGQuery('current', ['older'], { toolContext: 'shell(command=ls)' });
    const toolIdx = result.indexOf('[tools:');
    const currentIdx = result.indexOf('current');
    expect(toolIdx).toBeLessThan(currentIdx);
  });

  it('skips tool context when remaining budget is <= 10 chars', () => {
    const longInput = 'x'.repeat(990);
    const result = buildRAGQuery(longInput, [], {
      maxQueryChars: 1000,
      toolContext: 'shell(command=ls)',
    });
    expect(result).not.toContain('[tools:');
  });

  it('includes tool context even with no recent user texts', () => {
    const result = buildRAGQuery('current question', [], {
      toolContext: 'shell(command=pwd)',
    });
    expect(result).toContain('[tools: shell(command=pwd)]');
    expect(result).toContain('current question');
  });
});

describe('applyStickiness', () => {
  const makeResults = (
    items: Array<{ fact: string; similarity: number; domain: string }>,
  ): RAGSearchResult[] => items;

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
    const results = makeResults([{ fact: 'fact A', similarity: 0.98, domain: 'general' }]);
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

  it('applies default topKPerDomain=5 and maxResults=15 when no options given', () => {
    // Create 8 results per domain across 3 domains = 24 total
    const results: RAGSearchResult[] = [];
    for (let d = 0; d < 3; d++) {
      for (let i = 0; i < 8; i++) {
        results.push({
          fact: `d${d}-fact${i}`,
          similarity: 0.9 - i * 0.01,
          domain: `domain-${d}`,
        });
      }
    }
    const previous = new Set(['d0-fact0']);
    const output = applyStickiness(results, previous);
    // Per-domain cap of 5 should apply
    for (let d = 0; d < 3; d++) {
      const domainResults = output.filter((r) => r.domain === `domain-${d}`);
      expect(domainResults.length).toBeLessThanOrEqual(5);
    }
    // Total cap of 15 should apply
    expect(output.length).toBeLessThanOrEqual(15);
  });

  it('boost is applied to input similarity regardless of source', () => {
    const results = makeResults([{ fact: 'fact A', similarity: 0.8, domain: 'general' }]);
    // Apply stickiness twice — the second call uses the boosted similarity from the first call
    const prev1 = new Set(['fact A']);
    const output1 = applyStickiness(results, prev1);
    expect(output1[0].similarity).toBeCloseTo(0.85, 5);

    // Stickiness is applied again to whatever similarity the results currently have
    const output2 = applyStickiness(output1, prev1);
    expect(output2[0].similarity).toBeCloseTo(0.9, 5);
  });
});
