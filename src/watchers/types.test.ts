import { describe, it, expect } from 'vitest';

import { WatcherStore } from './store.js';
import { MAX_FIRES_CEILING, isWatcher, listableWatchers } from './types.js';

/**
 * The record guard and the creation clamps.
 *
 * Both are validated on READ as well as on write, because the file is the user's
 * own and hand-editable between runs — a write-time check alone is the
 * time-of-check/time-of-use gap #420 R6 names.
 */
function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'aaaa-bbbb',
    name: 'w',
    createdAt: new Date().toISOString(),
    ownerSessionId: 's1',
    ownerPid: 1,
    status: 'active',
    target: { kind: 'file', path: '/p' },
    predicate: { kind: 'changed' },
    instructions: 'do the thing',
    intervalMs: 60_000,
    failureCount: 0,
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    ...over,
  };
}

describe('isWatcher — the where clause', () => {
  it('accepts the three scalars', () => {
    for (const equals of ['x', 1, false]) {
      expect(
        isWatcher(
          record({
            predicate: { kind: 'appeared', idPath: '$.a.id', where: { path: 'p', equals } },
          }),
        ),
        String(equals),
      ).toBe(true);
    }
  });

  it('refuses a where with no comparable value', () => {
    // `idsAt` compares with `!==`, so a `where` whose `equals` is missing or is
    // an object never matches anything: the filter excludes every item, the id
    // set is permanently empty, and the watcher polls cleanly forever without
    // being able to fire. That is the same silent-inertness failure
    // `idPathRefusal` exists for, reached through the other half of the
    // predicate — which is why the guard refuses rather than repairing.
    for (const where of [{ path: 'p' }, { path: 'p', equals: {} }, { path: 'p', equals: null }]) {
      expect(
        isWatcher(record({ predicate: { kind: 'appeared', idPath: '$.a.id', where } })),
        JSON.stringify(where),
      ).toBe(false);
    }
  });
});

describe('isWatcher — the re-arm counters', () => {
  it('refuses a non-numeric maxFires', () => {
    // The re-arm arithmetic is `fireCount >= maxFires`, and a comparison against
    // a string is simply `false` — so a hand-edited `maxFires: "lots"` does not
    // fail loudly, it removes the ceiling on the one shape here that can run
    // away.
    expect(isWatcher(record({ maxFires: 'lots' }))).toBe(false);
    expect(isWatcher(record({ fireCount: null }))).toBe(false);
    expect(isWatcher(record({ maxFires: 3, fireCount: 1 }))).toBe(true);
  });
});

describe('WatcherStore.create — clamps', () => {
  it('clamps maxFires the way intervalMs and ttlMs are clamped', () => {
    const store = new WatcherStore();
    for (const w of store.list()) store.remove(w.id);
    const base = {
      name: 'w',
      target: { kind: 'file', path: '/p' } as const,
      predicate: { kind: 'changed' } as const,
      instructions: 'go',
      ownerSessionId: 's1',
      repeating: true,
    };
    // The one bound that exists specifically to stop a runaway was the one a
    // model could set to a million, leaving `expiresAt` a week away as the only
    // real limit.
    expect(store.create({ ...base, maxFires: 1_000_000 }).maxFires).toBe(MAX_FIRES_CEILING);
    expect(store.create({ ...base, maxFires: 0 }).maxFires).toBe(1);
    expect(store.create({ ...base, maxFires: 7 }).maxFires).toBe(7);
  });
});

describe('WatcherStore.findDuplicate', () => {
  it('never calls two time watchers duplicates, and still catches a repeated target', () => {
    // "Remind me at 3pm to do X" and "…to do Y" are both wanted, and the
    // instruction is exactly what the duplicate key deliberately excludes — so
    // `time` has no identity rather than a random one. A random term would make
    // an equality function non-deterministic, so the same record compared
    // against itself is unequal and the next caller to hold two keys is
    // silently wrong.
    const store = new WatcherStore();
    for (const w of store.list()) store.remove(w.id);
    const at = new Date(Date.now() + 60_000).toISOString();
    const mk = (over: Record<string, unknown>) =>
      store.create({
        name: 'w',
        target: { kind: 'time', at },
        predicate: { kind: 'changed' },
        instructions: 'go',
        ownerSessionId: 's1',
        ...over,
      });
    mk({});
    expect(store.findDuplicate({ kind: 'time', at }, { kind: 'changed' })).toBeNull();

    const file = store.create({
      name: 'f',
      target: { kind: 'file', path: '/p' },
      predicate: { kind: 'changed' },
      instructions: 'go',
      ownerSessionId: 's1',
    });
    expect(store.findDuplicate({ kind: 'file', path: '/p' }, { kind: 'changed' })?.id).toBe(
      file.id,
    );
  });

  it('keys on the target, not on the order its args were built in', () => {
    const store = new WatcherStore();
    for (const w of store.list()) store.remove(w.id);
    const w = store.create({
      name: 'm',
      target: { kind: 'mcp', tool: 't', args: { a: 1, b: 'two' } },
      predicate: { kind: 'changed' },
      instructions: 'go',
      ownerSessionId: 's1',
    });
    expect(
      store.findDuplicate({ kind: 'mcp', tool: 't', args: { b: 'two', a: 1 } }, { kind: 'changed' })
        ?.id,
    ).toBe(w.id);
  });
});

describe('listableWatchers', () => {
  const at = (status: string) =>
    ({ ...record({ status }) }) as unknown as Parameters<typeof listableWatchers>[0][number];

  it('shows live ones and drops the ones that are done', () => {
    // Bernard cancels six, reports them cleared, and `/watchers` showed six
    // rows every one of which said `cancelled` — both true, contradicting each
    // other on screen. `sweep` keeps them for 24 h on purpose; that is right
    // for the store and wrong for a list a person reads.
    const all = ['active', 'cancelled', 'fired', 'expired'].map(at);
    expect(listableWatchers(all).map((w) => w.status)).toEqual(['active']);
  });

  it('keeps a FAILED one, because it is the only place lastError is readable', () => {
    // The asymmetry is deliberate. Hiding this one means a user can never
    // learn why a watcher stopped, and `sweep`'s retention exists to protect
    // exactly this record — ageing it from the wrong timestamp already deleted
    // it before anyone could read it once.
    const all = [at('cancelled'), at('failed')];
    expect(listableWatchers(all).map((w) => w.status)).toEqual(['failed']);
  });
});
