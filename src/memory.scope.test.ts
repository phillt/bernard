import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTempHome } from './__tests__/temp-home.js';
import type { MemoryStore as MemoryStoreType } from './memory.js';

/**
 * The store half of the knowledge fence (#511), against a REAL directory.
 *
 * A mocked `node:fs` cannot answer the questions that matter here — whether a
 * scoped view actually stops seeing a file that exists, and whether the
 * sanitizer runs on the same side of the comparison in both directions — so
 * this follows `memory.disk.test.ts` rather than `memory.test.ts`.
 *
 * The property under test is stated once and then pinned from several angles:
 * **a view can only ever narrow.** Widening is not "discouraged", it is
 * unrepresentable, because the intersection happens inside `scoped()` and no
 * public method takes a scope argument.
 */
useTempHome('bernard-memory-scope');

let MemoryStore: typeof MemoryStoreType;
let MemoryScopeError: new (k: string, s: readonly string[]) => Error;
let keyInScope: (key: string, scope: readonly string[]) => boolean;
let isValidScopePattern: (p: unknown) => boolean;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('./memory.js');
  MemoryStore = mod.MemoryStore;
  MemoryScopeError = mod.MemoryScopeError as never;
  keyInScope = mod.keyInScope;
  isValidScopePattern = mod.isValidScopePattern;
});

describe('isValidScopePattern', () => {
  it('accepts an exact key and a trailing-star prefix', () => {
    expect(isValidScopePattern('proj-secret')).toBe(true);
    expect(isValidScopePattern('proj-')).toBe(true);
    expect(isValidScopePattern('proj*')).toBe(true);
  });

  // The alphabet is `sanitizeKey`'s plus one optional star, so anything richer
  // is an authoring mistake rather than a rule — it could never match a key
  // that exists.
  it('rejects anything that is a language rather than a pattern', () => {
    for (const bad of ['*', '*proj', 'a*b', 'proj/*', 'proj.*', '.*', '', 'a b', 42, null, ['x']]) {
      expect(isValidScopePattern(bad)).toBe(false);
    }
  });
});

describe('keyInScope', () => {
  it('matches an exact key and a prefix', () => {
    expect(keyInScope('proj-a', ['proj-a'])).toBe(true);
    expect(keyInScope('proj-a', ['proj-'])).toBe(false);
    expect(keyInScope('proj-a', ['proj-*'])).toBe(true);
    expect(keyInScope('other', ['proj-*'])).toBe(false);
  });

  /**
   * The ordering argument, in both directions.
   *
   * `MemoryStore` repairs names and cannot stop — `CronNotesStore` imports
   * `sanitizeKey` — so `"pro j-secret"` and `"proj-secret"` address ONE file
   * and must get ONE verdict. Comparing raw keys gives two, which is a fence
   * with a hole shaped like a space bar.
   */
  it('compares the repaired key, so two spellings of one file agree', () => {
    expect(keyInScope('pro j-secret', ['proj-secret'])).toBe(true);
    expect(keyInScope('proj-secret', ['pro j-secret'])).toBe(true);
    expect(keyInScope('pro j-secret', ['proj-*'])).toBe(true);
    // A traversal-shaped key repairs INTO the fence and is admitted — which is
    // correct rather than a hole: `sanitizeKey` has already collapsed it to
    // `proj-a`, so it addresses the in-scope file and can reach nothing else.
    expect(keyInScope('../proj-a', ['proj-a'])).toBe(true);
    expect(keyInScope('../secrets', ['proj-*'])).toBe(false);
  });

  it('admits nothing under an empty scope', () => {
    expect(keyInScope('anything', [])).toBe(false);
  });
});

describe('a scoped MemoryStore', () => {
  function seeded(): MemoryStoreType {
    const store = new MemoryStore();
    store.writeMemory('proj-a', 'alpha');
    store.writeMemory('proj-b', 'beta');
    store.writeMemory('secrets', 'do not read');
    return store;
  }

  it('reads inside the fence and cannot see outside it', () => {
    const view = seeded().scoped(['proj-*']);
    expect(view.readMemory('proj-a')).toContain('alpha');
    expect(view.readMemory('secrets')).toBeNull();
  });

  // `listMemory` and `getAllMemoryContents` are the two READ chokepoints; a
  // fence on only one of them leaks through the other, and the context block
  // uses the second.
  it('hides out-of-scope keys from both listings', () => {
    const view = seeded().scoped(['proj-*']);
    expect(view.listMemory().sort()).toEqual(['proj-a', 'proj-b']);
    expect([...view.getAllMemoryContents().keys()].sort()).toEqual(['proj-a', 'proj-b']);
  });

  /**
   * Scope constrains WRITES too, which #511 does not ask for.
   *
   * Two reasons: a write you cannot read back is incoherent, and an unscoped
   * write from a fenced worker turns the fence into a PUBLISHING channel — the
   * worker writes `user-preferences` and `main` renders it next turn.
   */
  it('refuses a write outside the fence, naming the scope', () => {
    const view = seeded().scoped(['proj-*']);
    expect(() => view.writeMemory('secrets', 'x')).toThrow(MemoryScopeError);
    expect(() => view.writeMemory('secrets', 'x')).toThrow(/proj-\*/);
    expect(() => view.deleteMemory('secrets')).toThrow(MemoryScopeError);
    expect(() => view.retire('secrets')).toThrow(MemoryScopeError);
  });

  // Both halves, because a supersession names two keys and fencing only the
  // subject would let a scoped agent point an in-scope record at one it may
  // not see.
  it('refuses a supersession whose replacement is outside the fence', () => {
    const store = seeded();
    store.writeMemory('secrets-2', 'y');
    const view = store.scoped(['proj-*', 'secrets']);
    expect(() => view.supersede('secrets', 'secrets-2')).toThrow(MemoryScopeError);
  });

  it('allows an in-scope write', () => {
    const view = seeded().scoped(['proj-*']);
    view.writeMemory('proj-c', 'gamma');
    expect(view.readMemory('proj-c')).toContain('gamma');
  });
});

describe('narrowing is monotone', () => {
  it('a second scope can only intersect, never widen', () => {
    const store = new MemoryStore();
    store.writeMemory('proj-a', 'alpha');
    store.writeMemory('other', 'o');
    // Asserted through what the view can REACH, not through a scope accessor:
    // the effect is the property, and the bookkeeping is not public.
    const narrow = store.scoped(['proj-*']).scoped(['proj-a', 'other']);
    expect(narrow.readMemory('proj-a')).toContain('alpha');
    expect(narrow.readMemory('other')).toBeNull();
  });

  it('re-applying the same scope is idempotent, which is what lets two readers apply it', () => {
    // `dispatchToolWrapper` scopes before assembling child tools and
    // `runDefinition` re-derives the same scope from the same record. That is
    // only safe because the second application is a no-op.
    const store = new MemoryStore();
    store.writeMemory('proj-a', 'alpha');
    store.writeMemory('other', 'o');
    const twice = store.scoped(['proj-*']).scoped(['proj-*']);
    expect(twice.readMemory('proj-a')).toContain('alpha');
    expect(twice.readMemory('other')).toBeNull();
  });

  it('an empty scope is deny-all, not "declared nothing"', () => {
    const store = new MemoryStore();
    store.writeMemory('proj-a', 'alpha');
    const none = store.scoped([]);
    expect(none.listMemory()).toEqual([]);
    expect(none.readMemory('proj-a')).toBeNull();
  });

  it('scoped(null) is the identity, so the unscoped path allocates nothing', () => {
    const store = new MemoryStore();
    expect(store.scoped(null)).toBe(store);
    expect(store.scoped(undefined)).toBe(store);
  });
});

/**
 * The assertion that catches a refactor back to `new MemoryStore(scopeDir)`.
 *
 * `scratch` is a per-INSTANCE in-memory Map, so the per-owner-directory shape
 * `AppletStore(appId)` uses would hand every scoped dispatch an empty scratch —
 * `<scratch_notes>` renders blank, `scratch.read` returns nothing, and nothing
 * errors.
 */
describe('scratch is shared, not blanked', () => {
  it('a view sees the session notes it is allowed to see', () => {
    const store = new MemoryStore();
    store.writeScratch('proj-note', 'in scope');
    store.writeScratch('other-note', 'out of scope');
    const view = store.scoped(['proj-*']);
    expect(view.readScratch('proj-note')).toBe('in scope');
    expect(view.readScratch('other-note')).toBeNull();
    expect(view.listScratch()).toEqual(['proj-note']);
  });

  it('a note the view writes is visible to the parent, because it is one map', () => {
    const store = new MemoryStore();
    const view = store.scoped(['proj-*']);
    view.writeScratch('proj-note', 'from the worker');
    expect(store.readScratch('proj-note')).toBe('from the worker');
  });

  it('refuses an out-of-scope scratch write', () => {
    const store = new MemoryStore();
    expect(() => store.scoped(['proj-*']).writeScratch('other', 'x')).toThrow(MemoryScopeError);
  });
});

/**
 * The refusal reaches the model as a PERMISSION error, on every action.
 *
 * `supersede` used to carry a catch-all that reported anything thrown as
 * `invalid_args` — so a fence refusal raised inside it was reported as a
 * call-shape mistake, on the one action where the difference matters most: the
 * model would retry with a different spelling forever rather than learn it was
 * fenced.
 */
describe('a fence refusal is reported as a fence', () => {
  let createMemoryTool: typeof import('./tools/memory.js').createMemoryTool;

  beforeEach(async () => {
    createMemoryTool = (await import('./tools/memory.js')).createMemoryTool;
  });

  async function refuse(args: Record<string, unknown>): Promise<string> {
    const store = new MemoryStore();
    store.writeMemory('proj-a', 'alpha');
    store.writeMemory('secrets', 'x');
    const tool = createMemoryTool(store.scoped(['proj-*']));
    const r = await tool.execute(args as never, {} as never);
    return JSON.stringify(r);
  }

  it.each([
    ['write', { action: 'write', key: 'secrets', content: 'x' }],
    ['delete', { action: 'delete', key: 'secrets' }],
    ['retire', { action: 'retire', key: 'secrets' }],
    ['supersede', { action: 'supersede', key: 'secrets', replacement: 'proj-a' }],
  ])('%s', async (_name, args) => {
    const out = await refuse(args);
    expect(out).toContain('permission');
    expect(out).toMatch(/outside this agent's scope/);
  });
});
