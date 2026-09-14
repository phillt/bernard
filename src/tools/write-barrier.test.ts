import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({ debugLog: vi.fn(), isDebugEnabled: vi.fn(() => true) }));
const { debugLog } = await import('../logger.js');

import { runOrdered, __resetWriteBarrier } from './write-barrier.js';
import { runWithDispatchId } from '../framework/dispatch-context.js';

/**
 * Bernard sent a family text twice. `send_message` and `list_messages` were
 * issued in one parallel step; the read resolved in 12 ms, the write took 571 ms,
 * and the message it created is stamped 453 ms after the read returned. The
 * verification could not have seen it, the agent concluded the send had failed,
 * and it re-sent byte-identical.
 *
 * Every case below drives the real ordering rule. `deferred` rather than timers,
 * because what is under test is the happens-before edge, not a duration.
 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  __resetWriteBarrier();
  vi.mocked(debugLog).mockClear();
});

const waitLines = () =>
  vi.mocked(debugLog).mock.calls.filter((c) => c[0] === 'tool:read-after-write');

describe('runOrdered', () => {
  it('holds a read behind a write in flight in the same dispatch', async () => {
    const gate = deferred<void>();
    const order: string[] = [];

    await runWithDispatchId('d1', async () => {
      // Invoked synchronously in sequence, as the SDK dispatches a step's tool
      // calls — the write first, which is what all 91 observed overlaps look
      // like ("verify what I just did").
      const write = runOrdered(true, async () => {
        await gate.promise;
        order.push('write');
        return 'sent';
      });
      const read = runOrdered(false, async () => {
        order.push('read');
        return 'listed';
      });

      // The read is NOT allowed to have run yet, which is the whole property:
      // in the incident it had already returned by this point.
      await tick();
      expect(order).toEqual([]);

      gate.resolve();
      await Promise.all([write, read]);
    });

    expect(order).toEqual(['write', 'read']);
  });

  it('lets a read past when no write is in flight', async () => {
    // The common case by a very long way — 6,776 of 6,867 real tool calls — so
    // it must cost nothing and must not wait on anything.
    const order: string[] = [];
    await runWithDispatchId('d1', async () => {
      await runOrdered(false, async () => {
        order.push('a');
      });
      await runOrdered(false, async () => {
        order.push('b');
      });
    });
    expect(order).toEqual(['a', 'b']);
  });

  it('never makes a write wait, which is what rules out a deadlock', async () => {
    // Reads wait for writes and writes wait for nothing, so the graph is
    // acyclic. That is the property that licenses an UNBOUNDED wait — without
    // it, a bound would be doing load-bearing safety work.
    const gate = deferred<void>();
    const done: string[] = [];
    await runWithDispatchId('d1', async () => {
      const slow = runOrdered(true, async () => {
        await gate.promise;
        done.push('slow-write');
      });
      // A second write issued while the first is in flight must not block.
      await runOrdered(true, async () => {
        done.push('fast-write');
      });
      expect(done).toEqual(['fast-write']);
      gate.resolve();
      await slow;
    });
    expect(done).toEqual(['fast-write', 'slow-write']);
  });

  it('does not hold a read behind a DIFFERENT dispatch’s write', async () => {
    // `withSlot` allows four concurrent dispatches and each MCP delegation adds
    // another. A global set would make one sub-agent's write block an unrelated
    // sibling's read — serializing work that never raced.
    const gate = deferred<void>();
    const order: string[] = [];

    const write = runWithDispatchId('parent', () =>
      runOrdered(true, async () => {
        await gate.promise;
        order.push('other-write');
      }),
    );

    await runWithDispatchId('child', () =>
      runOrdered(false, async () => {
        order.push('read');
      }),
    );

    expect(order).toEqual(['read']);
    gate.resolve();
    await write;
  });

  it('releases the read when the write REJECTS, and does not swallow the throw', async () => {
    // `allSettled`, never `all`. A failed write that left a read hanging — or
    // that rejected a read which never called it — would be a worse failure
    // than the one being fixed.
    const order: string[] = [];
    await runWithDispatchId('d1', async () => {
      const write = runOrdered(true, async () => {
        throw new Error('send failed');
      });
      const read = runOrdered(false, async () => {
        order.push('read');
        return 'ok';
      });
      // The write's own caller still sees the failure.
      await expect(write).rejects.toThrow('send failed');
      await expect(read).resolves.toBe('ok');
    });
    expect(order).toEqual(['read']);
  });

  it('stops waiting on a write once it has settled', async () => {
    // A chained promise rather than a set would pin every later read behind the
    // longest write the dispatch ever ran.
    //
    // Asserted through the line the barrier already emits, because the outcome
    // alone cannot tell the two apart: awaiting an ALREADY-SETTLED promise
    // resolves immediately, so a read that wrongly waits still returns
    // instantly and still returns the right value. What a leaked entry really
    // costs is unbounded growth — a 75-step dispatch accumulating one promise
    // per write, re-walked by every later read — and `waitedOn` is where that
    // becomes visible.
    await runWithDispatchId('d1', async () => {
      await runOrdered(true, async () => 'done');
      let ran = false;
      await runOrdered(false, async () => {
        ran = true;
      });
      expect(ran).toBe(true);
    });
    expect(waitLines()).toHaveLength(0);
  });

  it('reports what a read actually waited on', async () => {
    // Guards the guard above: if the barrier stopped emitting this line
    // entirely, the zero-length assertion would pass for the wrong reason.
    const gate = deferred<void>();
    await runWithDispatchId('d1', async () => {
      const write = runOrdered(true, () => gate.promise);
      const read = runOrdered(false, async () => 'r');
      gate.resolve();
      await Promise.all([write, read]);
    });
    expect(waitLines()).toHaveLength(1);
    expect(waitLines()[0][1]).toMatchObject({ waitedOn: 1 });
  });

  it('runs straight through outside a dispatch', async () => {
    // MCP connect probes and REPL helpers: no model step, so no parallel
    // siblings to race.
    const gate = deferred<void>();
    const order: string[] = [];
    const write = runOrdered(true, async () => {
      await gate.promise;
      order.push('write');
    });
    await runOrdered(false, async () => {
      order.push('read');
    });
    expect(order).toEqual(['read']);
    gate.resolve();
    await write;
  });
});
