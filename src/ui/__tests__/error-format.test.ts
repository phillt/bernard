import { describe, it, expect } from 'vitest';
import { formatAgentError } from '../error-format.js';

const QUOTA_JSON =
  '{"type":"error","error":{"type":"insufficient_quota","code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details.","param":null},"sequence_number":2}';

describe('formatAgentError', () => {
  it('unwraps the Agent error wrapper and the provider JSON to the human message', () => {
    const err = new Error(`Agent error: ${QUOTA_JSON}`);
    const data = formatAgentError(err, false);
    expect(data.message).toBe(
      'You exceeded your current quota, please check your plan and billing details.',
    );
    expect(data.message).not.toContain('{'); // no raw JSON leaks through
  });

  it('strips repeated "Agent error:" prefixes', () => {
    const err = new Error('Agent error: Agent error: something broke');
    expect(formatAgentError(err, false).message).toBe('something broke');
  });

  it('classifies a quota error as rate_limit with a friendly title + hint', () => {
    const data = formatAgentError(new Error(`Agent error: ${QUOTA_JSON}`), false);
    expect(data.category).toBe('rate_limit');
    expect(data.title).toBe('Rate limit / quota');
    expect(data.hint).toMatch(/lineup/i);
  });

  it('omits details unless requested, and includes stack + cause when debug is on', () => {
    const cause = new Error('inner boom');
    const err = new Error('Agent error: outer', { cause });
    expect(formatAgentError(err, false).details).toBeUndefined();
    const withDetails = formatAgentError(err, true).details ?? '';
    expect(withDetails).toContain('Error: Agent error: outer');
    expect(withDetails).toContain('Caused by:');
    expect(withDetails).toContain('inner boom');
  });

  it('passes a plain non-JSON message through unchanged', () => {
    expect(formatAgentError(new Error('network unreachable'), false).message).toBe(
      'network unreachable',
    );
  });
});

describe('the shape the AI SDK actually throws', () => {
  // `TypeValidationError` is built as
  //   Type validation failed: Value: ${JSON.stringify(value)}.
  //   Error message: ${zod issues}
  // and the trailing zod issues carry their own braces. The old
  // `lastIndexOf('}')` landed inside that array, the parse failed, and the raw
  // string reached the panel — which is how a user saw a parser complaint when
  // the envelope inside it said the model was at capacity. The pre-existing
  // fixture had nothing after the closing brace, so this path never ran.
  const SDK_MESSAGE =
    'Agent error: Type validation failed: Value: {"error":{"message":' +
    '"The model is currently at capacity due to high demand. Please try again in a few minutes."}}.\n' +
    'Error message: [\n  {\n    "code": "invalid_type",\n    "expected": "object"\n  }\n]';

  it('finds the envelope even with prose and braces after it', () => {
    const out = formatAgentError(new Error(SDK_MESSAGE), false);
    expect(out.message).toBe(
      'The model is currently at capacity due to high demand. Please try again in a few minutes.',
    );
    expect(out.message).not.toContain('Type validation failed');
  });

  it('classifies provider capacity as a rate limit, with advice', () => {
    // xAI answers a capacity refusal with HTTP 200 and this sentence in the
    // body, so no status-code branch can catch it. It used to land on
    // `unknown`, whose user line said "Tool failed with an unrecognized error"
    // — a tool that was never involved.
    const out = formatAgentError(new Error(SDK_MESSAGE), false);
    // Only the category here: the hint is pinned by the pre-existing quota
    // test and the phrasing by `error-taxonomy.test.ts`. What this one adds is
    // that the brace fix and the classification fix COMPOSE on the real
    // message — neither neighbour exercises both.
    expect(out.category).toBe('rate_limit');
  });

  it('handles a brace inside a quoted value', () => {
    // String-aware matching: a `}` inside a string must not close the object.
    const err = new Error('boom {"error":{"message":"weird } value"}} trailing');
    expect(formatAgentError(err, false).message).toBe('weird } value');
  });
});
