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
