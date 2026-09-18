import { describe, it, expect } from 'vitest';
import { buildActivitySummary, appendActivitySummary } from './activity-summary.js';
import { parseFailureMarker, stripFailureMarker } from '../error-taxonomy.js';
import { detectResultFailure } from '../tool-result-shape.js';

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

  it('says it ran out of steps rather than "produced no text" (#370)', () => {
    // Two different facts wearing one sentence. "Produced no text summary"
    // reads as a model that chose to say nothing; a dispatch cut off at its
    // ceiling never reached the turn where it would have summarized, and that
    // is the fact that explains the empty result.
    const out = appendActivitySummary('', sampleSteps, 'subagent', {
      stepLimitHit: true,
      steps: 12,
    });
    expect(out).toContain('(subagent ran out of steps (12) before producing a text summary');
    expect(out).not.toContain('produced no text summary');
  });

  it('keeps the original preamble for a run that finished (#370)', () => {
    const out = appendActivitySummary('', sampleSteps, 'subagent', {
      stepLimitHit: false,
      steps: 3,
    });
    expect(out).toContain('(subagent produced no text summary');
  });
});

/**
 * A step-limited run reads as a failure everywhere, not at two formatters out of
 * six (#406).
 *
 * `task` and `tool-wrapper` mint a `status: 'error'` envelope; `sub`,
 * `specialist`, `pac-actor` and `mcp-delegate` return prose through THIS
 * function, and prose that is not an error reads as a success. So a run cut off
 * at its budget logged `status: 'ok'`, registered its truncated output as
 * citable evidence and bumped the tool's `successCount` — #395's accounting
 * defect reproduced for truncated returns rather than empty ones.
 *
 * Asserted here because this is the one function all four share; the four
 * formatters are covered by construction rather than by four near-identical
 * tests.
 */
describe('the step-limit verdict (#406)', () => {
  const sampleSteps = [
    {
      toolCalls: [{ toolName: 'shell', args: { command: 'ls' } }],
      toolResults: [{ result: 'file.txt' }],
    },
  ];
  const stepLimited = (text: string) =>
    appendActivitySummary(text, sampleSteps, 'subagent', { stepLimitHit: true, steps: 12 });

  it('reads as a failure, and carries the category', () => {
    const out = stepLimited('');
    expect(detectResultFailure(out)).toBeTruthy();
    expect(parseFailureMarker(out)).toBe('step_limit');
  });

  it('is a marker rather than an `Error:` prefix', () => {
    // The fork #406 posed. `step_limit` is already a `ToolErrorType` whose row
    // says low severity, retryable, not correctable — so every consumer lands
    // correctly with no third state invented, and partial-but-useful work is not
    // painted red. An `Error:` prefix would have got the detection and lost that.
    expect(stepLimited('')).not.toMatch(/^Error/);
  });

  it('keeps the human preamble on its own line, below the marker', () => {
    // The marker line is the machine channel and carries the model-facing
    // playbook, the format `wrap-with-specialist.ts` already mints;
    // `stripFailureMarker` removes exactly that line and leaves the sentence a
    // person reads.
    const out = stepLimited('');
    expect(stripFailureMarker(out)).toMatch(
      /^\(subagent ran out of steps \(12\) before producing a text summary/,
    );
  });

  it('says what to do about it, from the taxonomy rather than a fifth wording', () => {
    expect(stepLimited('')).toContain('check the current state before retrying');
  });

  it('leaves a step-limited run that produced real content alone', () => {
    // `relabelStepLimit`'s rule, matched rather than overridden: the model may
    // have wrapped up on its last step, and calling that a failure throws away
    // work that did happen.
    const out = stepLimited('Here is the refactor.');
    expect(detectResultFailure(out)).toBeFalsy();
    expect(out).toContain('Here is the refactor.');
  });

  it('leaves an ordinary empty run alone', () => {
    // Guards the guard: an unconditional marker would mark every run that simply
    // returned no text, which is a different fact.
    const out = appendActivitySummary('', sampleSteps, 'subagent', {
      stepLimitHit: false,
      steps: 3,
    });
    expect(detectResultFailure(out)).toBeFalsy();
  });
});
