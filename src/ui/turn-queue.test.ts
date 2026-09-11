import { describe, it, expect } from 'vitest';

import { TurnQueue, MAX_QUEUED_TURNS, describeSource } from './turn-queue.js';

const userTurn = (text: string) => ({
  text,
  source: { kind: 'remote' as const, label: 'ci' },
});

describe('TurnQueue', () => {
  it('is FIFO', () => {
    const q = new TurnQueue();
    q.enqueue(userTurn('first'));
    q.enqueue(userTurn('second'));
    expect(q.take()?.text).toBe('first');
    expect(q.take()?.text).toBe('second');
    expect(q.take()).toBeNull();
  });

  it('refuses the newest when full, rather than dropping the oldest', () => {
    // Dropping the oldest silently discards something already accepted and
    // reported as queued. Refusing tells the producer while it still has the
    // payload — `WorkQueue.enqueue` makes the same choice.
    const q = new TurnQueue();
    for (let i = 0; i < MAX_QUEUED_TURNS; i++) {
      expect(q.enqueue(userTurn(`t${i}`)).ok).toBe(true);
    }
    expect(q.enqueue(userTurn('overflow'))).toEqual({ ok: false });
    expect(q.take()?.text).toBe('t0');
  });

  it('carries a data channel opaquely', () => {
    // The queue must not be able to flatten the two channels into one — that is
    // the whole reason a watcher's observation is safe to queue.
    const q = new TurnQueue();
    q.enqueue({
      text: 'draft a reply',
      data: { text: 'OBSERVED BYTES' },
      source: { kind: 'watcher', watcherId: 'w1', name: 'John', reason: '1 new item' },
    });
    const t = q.take();
    expect(t?.text).toBe('draft a reply');
    expect(t?.text).not.toContain('OBSERVED');
    expect(t?.data?.text).toBe('OBSERVED BYTES');
  });

  it('reports its depth', () => {
    const q = new TurnQueue();
    expect(q.size).toBe(0);
    q.enqueue(userTurn('a'));
    expect(q.size).toBe(1);
    q.take();
    expect(q.size).toBe(0);
  });
});

describe('describeSource', () => {
  it('names each origin', () => {
    expect(
      describeSource({ kind: 'watcher', watcherId: 'w', name: 'John', reason: '1 new item' }),
    ).toMatch(/watcher "John" — 1 new item/);
    expect(describeSource({ kind: 'remote', label: 'ci' })).toMatch(/sent by ci/);
  });
});
