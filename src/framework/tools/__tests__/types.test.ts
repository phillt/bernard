import { describe, it, expect } from 'vitest';
import { ok, err, isToolResult, type ToolResult } from '../types.js';

describe('ToolResult helpers', () => {
  it('ok() wraps a value in a status:"ok" envelope', () => {
    const r = ok({ greeting: 'hi' });
    expect(r).toEqual({ status: 'ok', result: { greeting: 'hi' } });
  });

  it('err() wraps an error in a status:"error" envelope', () => {
    const r = err({ type: 'exec_failed', message: 'boom' });
    expect(r).toEqual({
      status: 'error',
      error: { type: 'exec_failed', message: 'boom' },
    });
  });

  it('narrows the union correctly via the status discriminator', () => {
    const r: ToolResult<number> = ok(42);
    if (r.status === 'ok') {
      // Type-narrow check — would be a TS error if discriminator were broken.
      expect(r.result + 1).toBe(43);
    } else {
      throw new Error('unreachable');
    }
  });

  it('isToolResult() recognizes ok and error envelopes', () => {
    expect(isToolResult(ok('x'))).toBe(true);
    expect(isToolResult(err({ type: 'unknown', message: '' }))).toBe(true);
  });

  it('isToolResult() rejects non-envelope shapes', () => {
    expect(isToolResult(null)).toBe(false);
    expect(isToolResult(undefined)).toBe(false);
    expect(isToolResult('plain string')).toBe(false);
    expect(isToolResult({ output: 'x', is_error: false })).toBe(false);
    expect(isToolResult({ status: 'success', result: 'x' })).toBe(false);
    expect(isToolResult(42)).toBe(false);
  });
});
