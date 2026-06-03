import { describe, it, expect } from 'vitest';
import { runWithDispatchId, getCurrentDispatchId } from '../dispatch-context.js';

describe('dispatch-context', () => {
  it('returns undefined outside a run scope', () => {
    expect(getCurrentDispatchId()).toBeUndefined();
  });

  it('makes dispatchId visible inside the run callback', () => {
    let seen: string | undefined;
    runWithDispatchId('abcd1234', () => {
      seen = getCurrentDispatchId();
    });
    expect(seen).toBe('abcd1234');
    expect(getCurrentDispatchId()).toBeUndefined();
  });

  it('propagates dispatchId through await boundaries', async () => {
    const seen: (string | undefined)[] = [];
    await runWithDispatchId('xyz', async () => {
      seen.push(getCurrentDispatchId());
      await new Promise((r) => setTimeout(r, 1));
      seen.push(getCurrentDispatchId());
      await Promise.resolve();
      seen.push(getCurrentDispatchId());
    });
    expect(seen).toEqual(['xyz', 'xyz', 'xyz']);
  });

  it('isolates concurrent dispatches', async () => {
    const a = runWithDispatchId('aa', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getCurrentDispatchId();
    });
    const b = runWithDispatchId('bb', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getCurrentDispatchId();
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe('aa');
    expect(rb).toBe('bb');
  });
});
