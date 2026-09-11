import { describe, it, expect } from 'vitest';

import { evaluate, digestOf, type Observation } from './evaluate.js';
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
