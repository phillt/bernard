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

  it('supersedes a waiting wake from the SAME watcher instead of queueing twice', () => {
    // Measured on a real session: a live chat produced five consecutive full
    // turns from one watcher over six minutes, each reacting to a message the
    // previous turn had already read and answered. Level-triggered means the
    // newest observation is the truth, so an older one queued behind it
    // describes a conversation that has already moved.
    const q = new TurnQueue();
    const fire = (reason: string, observed: string) => ({
      text: 'draft a reply',
      data: { text: observed },
      source: { kind: 'watcher' as const, watcherId: 'w1', name: 'Kaitlyn', reason },
    });
    expect(q.enqueue(fire('1 new item', 'FIRST')).ok).toBe(true);
    expect(q.enqueue(fire('2 new items', 'SECOND')).ok).toBe(true);

    expect(q.size).toBe(1);
    const t = q.take();
    // The NEWEST observation and the newest reason survive.
    expect(t?.data?.text).toBe('SECOND');
    expect(t?.source).toMatchObject({ reason: '2 new items' });
    expect(t?.coalesced).toBe(2);
    expect(q.take()).toBeNull();
  });

  it('keeps a superseded wake in its original place in line', () => {
    // The position was earned when the watcher first fired. Re-appending on
    // every supersede lets a chatty watcher starve itself behind turns that
    // arrived after it.
    const q = new TurnQueue();
    const w = (reason: string) => ({
      text: 'react',
      source: { kind: 'watcher' as const, watcherId: 'w1', name: 'W', reason },
    });
    q.enqueue(w('first'));
    q.enqueue(userTurn('later'));
    q.enqueue(w('second'));
    expect(q.take()?.source).toMatchObject({ kind: 'watcher', reason: 'second' });
    expect(q.take()?.text).toBe('later');
  });

  it('never folds two `say --run` messages together', () => {
    // A watcher's instruction is fixed at creation, so two fires are one job
    // seen twice. Two remote sends are two instructions somebody wrote, and
    // each was told it was delivered — folding them drops work.
    const q = new TurnQueue();
    q.enqueue({ text: 'deploy the thing', source: { kind: 'remote', label: 'ci' } });
    q.enqueue({ text: 'roll it back', source: { kind: 'remote', label: 'ci' } });
    expect(q.size).toBe(2);
  });

  it('folds two watchers separately', () => {
    const q = new TurnQueue();
    const w = (id: string) => ({
      text: 'react',
      source: { kind: 'watcher' as const, watcherId: id, name: id, reason: 'r' },
    });
    q.enqueue(w('a'));
    q.enqueue(w('b'));
    q.enqueue(w('a'));
    expect(q.size).toBe(2);
  });

  it('accepts a supersede even when the queue is full', () => {
    // It adds no entry, so the bound is untouched — and refusing it would make
    // the poller rewind a watcher that is already represented in the queue,
    // spending the rewind on nothing.
    const q = new TurnQueue();
    const w = {
      text: 'react',
      source: { kind: 'watcher' as const, watcherId: 'w1', name: 'W', reason: 'r' },
    };
    q.enqueue(w);
    for (let i = 1; i < MAX_QUEUED_TURNS; i++) q.enqueue(userTurn(`t${i}`));
    expect(q.size).toBe(MAX_QUEUED_TURNS);
    expect(q.enqueue({ ...w, source: { ...w.source, reason: 'newer' } }).ok).toBe(true);
    expect(q.size).toBe(MAX_QUEUED_TURNS);
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

  it('says when a wake stands for more than one fire', () => {
    // The reason describes the newest poll only, so a folded entry that said
    // just "2 new items" understates what the turn is about to read.
    const w = { kind: 'watcher' as const, watcherId: 'w', name: 'John', reason: '2 new items' };
    expect(describeSource(w, 3)).toMatch(/latest of 3 fires/);
    expect(describeSource(w, 1)).not.toMatch(/latest of/);
    expect(describeSource(w)).not.toMatch(/latest of/);
  });
});
