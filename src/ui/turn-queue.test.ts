import { describe, it, expect } from 'vitest';

import { TurnQueue, MAX_QUEUED_TURNS, announcementFor } from './turn-queue.js';

const userTurn = (text: string) => ({
  text,
  source: { kind: 'remote' as const, label: 'ci' },
});

const watcherTurn = (over: { id?: string; reason?: string; observed?: string } = {}) => ({
  text: 'draft a reply',
  ...(over.observed === undefined ? {} : { data: { text: over.observed } }),
  source: {
    kind: 'watcher' as const,
    watcherId: over.id ?? 'w1',
    name: 'John',
    reason: over.reason ?? '1 new item',
  },
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
    q.enqueue(watcherTurn({ observed: 'OBSERVED BYTES' }));
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

  it('lists what is waiting, oldest first, without handing over the live array', () => {
    // `/queue` holds this across two overlay awaits, during which the drain
    // loop and any watcher are free to mutate the queue — a caller left
    // holding the real array would watch its rows shift under it.
    const q = new TurnQueue();
    q.enqueue(userTurn('first'));
    q.enqueue(userTurn('second'));
    const listed = q.list();
    expect(listed.map((t) => t.text)).toEqual(['first', 'second']);
    q.take();
    expect(listed.map((t) => t.text)).toEqual(['first', 'second']);
    expect(q.list().map((t) => t.text)).toEqual(['second']);
  });

  it('removes a waiting turn by id, and says so when the id names nothing', () => {
    // The miss is the ordinary case rather than a corner: `/queue`'s rows are
    // read before the user decides, and the drain can take the chosen one in
    // between — which is exactly when the menu must say something other than
    // "dropped".
    const q = new TurnQueue();
    q.enqueue(userTurn('first'));
    q.enqueue(userTurn('second'));
    const [first, second] = q.list();
    expect(q.remove(first.id)).toBe(true);
    expect(q.list().map((t) => t.text)).toEqual(['second']);
    expect(q.remove(first.id)).toBe(false);
    expect(q.take()?.id).toBe(second.id);
  });
});

describe('announcementFor', () => {
  it('names each origin', () => {
    expect(
      announcementFor({ kind: 'watcher', watcherId: 'w', name: 'John', reason: '1 new item' })
        .origin,
    ).toMatch(/watcher "John" — 1 new item/);
    expect(announcementFor({ kind: 'remote', label: 'ci' }).origin).toMatch(/sent by ci/);
    expect(announcementFor({ kind: 'user' }).origin).toMatch(/by you/);
  });

  it('does not announce a turn the user queued as a wake', () => {
    // The reason the title travels WITH the origin rather than being decided by
    // the panel: "Woken" is true of the other two arms and false of this one,
    // so a source supplying only the meta row renders under a title that
    // contradicts it.
    expect(announcementFor({ kind: 'user' }).title).not.toMatch(/Woken/);
    expect(announcementFor({ kind: 'remote', label: 'ci' }).title).toMatch(/Woken/);
  });

  it('keeps every title to plain single-width glyphs', () => {
    // `glyph-width.ts`'s rule, applied where the titles are minted: an emoji in
    // a bordered header makes that row a different width from every other row
    // in the box and the frame breaks. Checked over the whole table rather than
    // per arm, so a fourth source inherits it.
    for (const source of [
      { kind: 'watcher' as const, watcherId: 'w', name: 'n', reason: 'r' },
      { kind: 'remote' as const, label: 'ci' },
      { kind: 'user' as const },
    ]) {
      expect(announcementFor(source).title).not.toMatch(/\p{Emoji}/u);
    }
  });
});
