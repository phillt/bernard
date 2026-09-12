import { describe, it, expect } from 'vitest';

import { evaluate, digestOf, MATCH_INPUT_MAX, type Observation } from './evaluate.js';
import { extractPath, idsAt, parsePath, stableStringify, PATH_PREFIX } from './extract.js';
import { ARG_REF_PREFIX } from '../apps/manifest.js';
import type { Watcher } from './types.js';

function watcher(over: Partial<Watcher> = {}): Watcher {
  return {
    schemaVersion: 1,
    id: 'w1',
    name: 'test',
    createdAt: new Date().toISOString(),
    ownerSessionId: 's1',
    ownerPid: process.pid,
    status: 'active',
    target: { kind: 'http', url: 'https://example.com' },
    predicate: { kind: 'changed' },
    instructions: 'do the thing',
    intervalMs: 60_000,
    failureCount: 0,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  };
}

const obs = (value: unknown, over: Partial<Observation> = {}): Observation => ({ value, ...over });

describe('extract', () => {
  it('uses the same path prefix the manifest already defines', () => {
    // One syntax in the product, not two. Restated rather than imported so the
    // leaf keeps no edge to the manifest's zod graph; this is the pin.
    expect(PATH_PREFIX).toBe(ARG_REF_PREFIX);
  });

  it('reads keys and array indices', () => {
    const v = { a: { b: [{ c: 7 }] } };
    expect(extractPath(v, '$.a.b[0].c')).toBe(7);
  });

  it('returns undefined for a malformed path rather than guessing', () => {
    // A path that silently means something else is how a watcher watches
    // nothing and reports success forever.
    expect(parsePath('a.b')).toBeNull();
    expect(parsePath('$.')).toBeNull();
    expect(extractPath({ a: 1 }, 'a')).toBeUndefined();
  });

  it('refuses to traverse a prototype', () => {
    // MCP output reaches us through JSON.parse, which makes `__proto__` a real
    // own property. Benign today, which is why it is refused not relied upon.
    const v = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
    expect(extractPath(v, '$.__proto__.polluted')).toBeUndefined();
  });

  it('digests structurally equal values equally regardless of key order', () => {
    // Without this a server reordering its JSON keys reads as "John replied".
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('ignores insignificant whitespace, including inside nested strings', () => {
    expect(digestOf('hello   world')).toBe(digestOf('hello world'));
    // A real newline, which is the case that caught the ordering bug: collapsing
    // AFTER JSON.stringify is too late, because the newline is already the two
    // characters `\` and `n` by then.
    expect(digestOf(' a\n\nb ')).toBe(digestOf('a b'));
    // And nested, which is where a tool result's prose actually lives — a body
    // that re-wraps must not read as a change.
    expect(digestOf({ body: 'one   two' })).toBe(digestOf({ body: 'one two' }));
    expect(digestOf({ m: [{ t: 'x\n y' }] })).toBe(digestOf({ m: [{ t: 'x y' }] }));
  });

  it('reads an id list, and reports null when the path is not a list', () => {
    const v = { messages: [{ id: 'm1' }, { id: 'm2' }] };
    expect(idsAt(v, '$.messages.id')).toEqual(['m1', 'm2']);
    expect(idsAt({ messages: 'nope' }, '$.messages.id')).toBeNull();
  });
});

describe('evaluate — changed', () => {
  it('does NOT fire when it has no baseline', () => {
    // THE rule that makes "tell me when this changes" mean what it says. Without
    // it every watcher wakes the instant it is created, because a real digest
    // compares unequal to nothing.
    const r = evaluate(watcher({ snapshot: undefined }), obs('anything'));
    expect(r.fired).toBe(false);
    expect(r.snapshot).toBe(digestOf('anything'));
  });

  it('fires when the digest differs, and not when it matches', () => {
    const w = watcher({ snapshot: digestOf('before') });
    expect(evaluate(w, obs('before')).fired).toBe(false);
    expect(evaluate(w, obs('after')).fired).toBe(true);
  });

  it('is level-triggered: N missed polls still fire on the next one', () => {
    // The property the whole design rests on, and the reason cron's dropped
    // fires (#400) are not a prerequisite. Nothing here counts polls.
    const w = watcher({ snapshot: digestOf('v1') });
    for (let i = 0; i < 11; i++) {
      /* eleven polls that never happened */
    }
    expect(evaluate(w, obs('v12')).fired).toBe(true);
  });

  it('trusts a 304 without re-digesting', () => {
    const w = watcher({ snapshot: digestOf('v1') });
    const r = evaluate(w, obs('IRRELEVANT BODY', { unchanged: true }));
    expect(r.fired).toBe(false);
    expect(r.snapshot).toBe(w.snapshot);
  });
});

describe('evaluate — appeared', () => {
  const pred = { kind: 'appeared' as const, idPath: '$.messages.id' };

  it('fires only on an id not in the baseline', () => {
    const w = watcher({ predicate: pred, baselineIds: ['m1'] });
    const same = evaluate(w, obs({ messages: [{ id: 'm1' }] }));
    expect(same.fired).toBe(false);

    const fresh = evaluate(w, obs({ messages: [{ id: 'm1' }, { id: 'm2' }] }));
    expect(fresh.fired).toBe(true);
    expect(fresh.reason).toMatch(/1 new item/);
  });

  it('does not fire on a REMOVAL, which `changed` would', () => {
    // The reason `appeared` exists: "John replied" is not "the mailbox differs".
    const w = watcher({ predicate: pred, baselineIds: ['m1', 'm2'] });
    expect(evaluate(w, obs({ messages: [{ id: 'm1' }] })).fired).toBe(false);
  });

  it('carries current ids forward so a reappearance is not new', () => {
    const w = watcher({ predicate: pred, baselineIds: ['m1', 'm2'] });
    const gone = evaluate(w, obs({ messages: [{ id: 'm1' }] }));
    expect(gone.baselineIds).toEqual(['m1']);
  });

  it('treats an unreadable path as "cannot evaluate", never as an empty list', () => {
    // An empty baseline makes every pre-existing item look new on the next poll
    // — a false wake naming things that were always there.
    const w = watcher({ predicate: pred, baselineIds: ['m1'] });
    const r = evaluate(w, obs({ messages: 'not-a-list' }));
    expect(r.fired).toBe(false);
    expect(r.baselineIds).toEqual(['m1']);
  });
});

describe('evaluate — matches and time', () => {
  it('fires on a match', () => {
    const w = watcher({ predicate: { kind: 'matches', pattern: 'from:john' } });
    expect(evaluate(w, obs('mail from:john here')).fired).toBe(true);
    expect(evaluate(w, obs('mail from:jane here')).fired).toBe(false);
  });

  it('does not fire on an unparseable pattern', () => {
    const w = watcher({ predicate: { kind: 'matches', pattern: '([' } });
    expect(evaluate(w, obs('anything')).fired).toBe(false);
  });

  it('fires a time target on arrival, since isDue already gated it', () => {
    const at = new Date(Date.now() - 1000).toISOString();
    const w = watcher({ target: { kind: 'time', at } });
    const r = evaluate(w, obs(null));
    expect(r.fired).toBe(true);
    expect(r.reason).toMatch(/scheduled time/);
  });
});

/**
 * `matches` bounds the WORK, and must not move a byte (#572).
 *
 * It used to serialise the whole value and then keep 4 KB — 61 ms for a 12 MB
 * payload. The obvious reuse for that is `boundedStringify`, which
 * `renderObservation` already uses, and it is WRONG here: it does not sort keys
 * and it drops array elements past 100 regardless of the character budget.
 * These tests exist to fail if anyone swaps it in.
 */
describe('evaluate — matches is bounded without changing what it sees', () => {
  const w = (pattern: string) =>
    watcher({ target: { kind: 'http', url: 'u' }, predicate: { kind: 'matches', pattern } });
  it('still sees an element past the 100th when the text fits', () => {
    // THE regression guard. 150 short items serialise well under
    // `MATCH_INPUT_MAX`, so today every one of them is visible to the pattern.
    // `boundedStringify` would drop elements 101+ before the character budget
    // was anywhere near spent, and a watcher matching an id in the tail would
    // go silently inert.
    const items = Array.from({ length: 150 }, (_, i) => ({ id: `order-${i}` }));
    expect(stableStringify({ items }).length).toBeLessThan(MATCH_INPUT_MAX);
    expect(evaluate(w('order-140'), obs({ items })).fired).toBe(true);
  });

  it('still sorts keys, so a two-key pattern means what it meant', () => {
    // `stableStringify` sorts; `JSON.stringify` follows insertion order. A
    // pattern spanning two keys matches under one and not the other.
    expect(evaluate(w('"a":1,"b":2'), obs({ b: 2, a: 1 })).fired).toBe(true);
  });

  it('shows the pattern the same prefix the unbounded walk would', () => {
    // The invariant, stated on the predicate rather than only on the helper:
    // a pattern hitting the first 4 KB fires, one past it does not — exactly as
    // before the budget was introduced.
    const value = { aaa: 'NEAR', zzz: `${'x'.repeat(MATCH_INPUT_MAX)}FAR` };
    expect(evaluate(w('NEAR'), obs(value)).fired).toBe(true);
    expect(evaluate(w('FAR'), obs(value)).fired).toBe(false);
  });

  it('does the bounded work, not the whole walk', () => {
    // Counting property reads rather than wall-clock, which flakes in CI. An
    // unbounded walk touches every element; a bounded one stops.
    let reads = 0;
    const items = Array.from({ length: 20_000 }, (_, i) => {
      const o = { n: i, pad: 'y'.repeat(50) };
      return new Proxy(o, {
        get(t, k: string) {
          reads++;
          return (t as Record<string, unknown>)[k];
        },
        ownKeys: (t) => Reflect.ownKeys(t),
      });
    });
    evaluate(w('nothing-matches-this'), obs({ items }));
    expect(reads).toBeLessThan(1_000);
  });
});

describe('digestOf stays unbounded', () => {
  it('notices a change past the matches budget', () => {
    // The guard against a future pass "fixing" `digestOf` for symmetry with
    // `matches`. A digest over a prefix cannot see anything after it, so the
    // watcher would poll cleanly forever and never fire.
    const head = 'h'.repeat(MATCH_INPUT_MAX * 2);
    expect(digestOf({ a: `${head}one` })).not.toBe(digestOf({ a: `${head}two` }));
  });
});

describe('stableStringify — the budget preserves the prefix', () => {
  const sample = {
    zebra: 'z'.repeat(300),
    alpha: Array.from({ length: 400 }, (_, i) => ({ id: i, body: 'b'.repeat(40) })),
    middle: { nested: 'n'.repeat(2_000), other: 7 },
  };

  it('is byte-identical to the unbounded walk, up to the budget', () => {
    const full = stableStringify(sample);
    for (const n of [1, 17, 200, 1_000, 4_000]) {
      expect(stableStringify(sample, { maxChars: n }).slice(0, n)).toBe(full.slice(0, n));
    }
  });

  it('holds with collapseWhitespace too', () => {
    // The normalisation runs over the WHOLE leaf before any clipping, because
    // it does not commute with slicing: collapsing "a\n\n\nb" gives "a b",
    // while collapsing the prefix "a\n" gives "a ".
    const v = { k: `a${'\n'.repeat(50)}b`, j: 'x'.repeat(500) };
    const full = stableStringify(v, { collapseWhitespace: true });
    for (const n of [3, 40, 300]) {
      expect(stableStringify(v, { collapseWhitespace: true, maxChars: n }).slice(0, n)).toBe(
        full.slice(0, n),
      );
    }
  });

  it('bounds a document whose leaves are all NUMBERS', () => {
    // The budget charged only string leaves, so a numeric payload never
    // tripped `spent()`, neither loop broke, and `{maxChars: N}` returned the
    // whole 1.5 MB — byte-identical to the unbounded walk and slower for the
    // bookkeeping. Exactly the shape `MATCH_INPUT_MAX` exists for.
    //
    // A bare nested ARRAY, so there are no keys: charging keys alone would
    // otherwise bound this and hide a missing charge on the numbers.
    const nums = Array.from({ length: 5_000 }, (_, i) => [i, i + 1, i + 2]);
    const full = stableStringify(nums);
    const bounded = stableStringify(nums, { maxChars: 500 });
    expect(full.length).toBeGreaterThan(50_000);
    expect(bounded.length).toBeLessThan(full.length / 10);
    expect(bounded.slice(0, 500)).toBe(full.slice(0, 500));
  });

  it('bounds a document that is all KEYS', () => {
    // The other half of the same hole: a key is emitted straight through
    // `JSON.stringify(k)` rather than the leaf path. Values are EMPTY objects
    // so nothing else can be charged — with the key charge removed, this walk
    // is entirely uncounted.
    const keys: Record<string, unknown> = {};
    for (let i = 0; i < 5_000; i++) keys[`key${i}`] = {};
    const full = stableStringify(keys);
    const bounded = stableStringify(keys, { maxChars: 500 });
    expect(full.length).toBeGreaterThan(50_000);
    expect(bounded.length).toBeLessThan(full.length / 10);
    expect(bounded.slice(0, 500)).toBe(full.slice(0, 500));
  });

  it('is unbounded when no budget is given', () => {
    // So a default can never be slipped in — every stored `changed` snapshot
    // depends on this walk seeing the whole value.
    expect(stableStringify(sample)).toBe(stableStringify(sample, {}));
    expect(stableStringify(sample).length).toBeGreaterThan(10_000);
  });
});
