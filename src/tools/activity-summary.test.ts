import { describe, it, expect } from 'vitest';
import { buildActivitySummary, appendActivitySummary } from './activity-summary.js';

describe('buildActivitySummary', () => {
  it('returns "no tool calls" when steps is empty', () => {
    expect(buildActivitySummary([])).toBe('## Activity Log\n(no tool calls)');
  });

  it('returns "no tool calls" when steps is undefined', () => {
    expect(buildActivitySummary(undefined)).toBe('## Activity Log\n(no tool calls)');
  });

  it('returns "no tool calls" when steps have no tool calls', () => {
    const steps = [{ toolCalls: [], toolResults: [] }];
    expect(buildActivitySummary(steps)).toBe('## Activity Log\n(no tool calls)');
  });

  it('numbers each tool call across multiple steps', () => {
    const steps = [
      {
        toolCalls: [{ toolName: 'shell', args: { command: 'gh pr review' } }],
        toolResults: [{ result: 'review submitted' }],
      },
      {
        toolCalls: [{ toolName: 'shell', args: { command: 'gh pr edit' } }],
        toolResults: [{ result: 'assignee changed' }],
      },
    ];
    const summary = buildActivitySummary(steps);
    expect(summary).toContain('## Activity Log');
    expect(summary).toContain('2 tool call(s):');
    expect(summary).toContain('1. shell(');
    expect(summary).toContain('2. shell(');
    expect(summary).toContain('review submitted');
    expect(summary).toContain('assignee changed');
  });

  it('clips long string results to RESULT_PREVIEW (400 chars)', () => {
    const longResult = 'x'.repeat(1000);
    const steps = [
      {
        toolCalls: [{ toolName: 'shell', args: { command: 'cat big' } }],
        toolResults: [{ result: longResult }],
      },
    ];
    const summary = buildActivitySummary(steps);
    expect(summary).toContain('x'.repeat(400));
    expect(summary).not.toContain('x'.repeat(401));
  });

  it('clips long args JSON to ARG_PREVIEW (200 chars)', () => {
    const bigArg = 'a'.repeat(500);
    const steps = [
      {
        toolCalls: [{ toolName: 'shell', args: { command: bigArg } }],
        toolResults: [{ result: 'ok' }],
      },
    ];
    const summary = buildActivitySummary(steps);
    const argLine = summary.split('\n').find((l) => l.startsWith('1. shell('));
    expect(argLine).toBeDefined();
    // argLine is "1. shell(<json>)". The JSON portion is at most 200 chars.
    const jsonPart = argLine!.slice('1. shell('.length);
    expect(jsonPart.length).toBeLessThanOrEqual(201); // +1 for trailing ')'
  });

  it('JSON-stringifies non-string results', () => {
    const steps = [
      {
        toolCalls: [{ toolName: 'web_search', args: { query: 'x' } }],
        toolResults: [{ result: { hits: 3, urls: ['a', 'b'] } }],
      },
    ];
    const summary = buildActivitySummary(steps);
    expect(summary).toContain('"hits":3');
    expect(summary).toContain('"urls":["a","b"]');
  });
});

describe('appendActivitySummary', () => {
  const sampleSteps = [
    {
      toolCalls: [{ toolName: 'shell', args: { command: 'ls' } }],
      toolResults: [{ result: 'file.txt' }],
    },
  ];

  it('preserves model text and appends the activity log', () => {
    const out = appendActivitySummary('done', sampleSteps, 'agent');
    expect(out.startsWith('done')).toBe(true);
    expect(out).toContain('## Activity Log');
    expect(out).toContain('1 tool call(s):');
    expect(out).toContain('shell');
  });

  it('treats whitespace-only text as empty and emits the preamble', () => {
    const out = appendActivitySummary('   \n  ', sampleSteps, 'specialist');
    expect(out).toContain(
      '(specialist produced no text summary; activity reconstructed from tool-call log)',
    );
    expect(out).toContain('## Activity Log');
    expect(out).toContain('shell');
  });

  it('emits the preamble plus "no tool calls" when text is empty and no steps', () => {
    const out = appendActivitySummary('', [], 'specialist');
    expect(out).toContain('(specialist produced no text summary');
    expect(out).toContain('(no tool calls)');
  });

  it('does not emit the preamble when text is non-empty', () => {
    const out = appendActivitySummary('actual response', sampleSteps, 'agent');
    expect(out).not.toContain('produced no text summary');
  });

  it('uses provided agent label in preamble', () => {
    const out = appendActivitySummary('', sampleSteps, 'subagent');
    expect(out).toContain('(subagent produced no text summary');
  });
});
