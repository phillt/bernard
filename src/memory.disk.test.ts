import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as realFs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from './__tests__/temp-home.js';
import type { MemoryStore as MemoryStoreType } from './memory.js';

/**
 * The on-disk half of `MemoryStore` (#513), against a REAL directory.
 *
 * `memory.test.ts` mocks `node:fs` wholesale, which is right for call shape and
 * useless for everything here: what a round trip produces, whether a legacy
 * file still reads, whether the cache actually re-reads after a sibling write.
 * Those are questions about bytes on a disk, and a mock can only answer with
 * whatever it was told to say.
 *
 * `MEMORY_DIR` is a module-level const resolved from `BERNARD_HOME` at import,
 * so every test re-imports after `useTempHome` has set it.
 */
useTempHome('bernard-memory-disk');

let MemoryStore: typeof MemoryStoreType;
let sanitizeKey: (k: string) => string;
let MemoryKeyCollisionError: new (a: string, b: string) => Error;
let memDir: string;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('./memory.js');
  MemoryStore = mod.MemoryStore;
  sanitizeKey = mod.sanitizeKey;
  MemoryKeyCollisionError = mod.MemoryKeyCollisionError;
  // Read from `paths.js` rather than reconstructed: `BERNARD_HOME` selects a
  // FLAT layout, so guessing the shape here would silently test a directory
  // the store never touches.
  memDir = (await import('./paths.js')).MEMORY_DIR;
});

/** Writes a file into the memory directory behind the store's back. */
function seed(filename: string, source: string): string {
  realFs.mkdirSync(memDir, { recursive: true });
  const p = path.join(memDir, filename);
  realFs.writeFileSync(p, source, 'utf-8');
  return p;
}

function raw(key: string): string {
  return realFs.readFileSync(path.join(memDir, `${sanitizeKey(key)}.md`), 'utf-8');
}

describe('legacy files — the entire existing corpus', () => {
  it('reads a file with no front matter as body, verbatim', () => {
    // Measured before building this: zero of the 30 files on a real install
    // start with `---`, so every one takes this path on first read. That is why
    // there is no migration step anywhere in this change.
    const body = '# Notes\n\nKaitlyn is my wife.\n';
    seed('kaitlyn.md', body);
    expect(new MemoryStore().readMemory('kaitlyn')).toBe(body);
  });

  it('backfills writtenAt from mtime rather than leaving it undefined', () => {
    const p = seed('old.md', 'x');
    const when = new Date('2026-03-11T15:21:00.000Z');
    realFs.utimesSync(p, when, when);
    const record = new MemoryStore().readRecord('old');
    expect(record?.writtenAt).toBe(when.toISOString());
  });

  it('falls back to the sanitized filename when no key was recorded', () => {
    seed('email-accounts.md', 'x');
    expect(new MemoryStore().readRecord('email-accounts')?.key).toBe('email-accounts');
  });

  it('treats a fence carrying only a key: line as prose, not metadata', () => {
    // `key:` is an ordinary line in prose about YAML, and these files are
    // model-written — a memory documenting a config format would otherwise be
    // silently decapitated. `writtenAt`/`supersededBy` are the discriminators
    // because `serializeMemory` is the only thing that writes them.
    const body = '---\nkey: some.setting\nvalue: 3\n---\nHow the config works.\n';
    seed('yaml-note.md', body);
    expect(new MemoryStore().readMemory('yaml-note')).toBe(body);
  });

  it('does not decapitate a body that legitimately opens with a rule', () => {
    // `docs-store.parseDoc` returns null here and its callers drop the doc.
    // Dropping is not available for a user's memory, so a fence carrying
    // nothing recognised is treated as body. These files are model-written;
    // silently eating the first paragraph would be invisible and permanent.
    const body = '---\nsome: prose\nthat: is not metadata\n---\nthe real note\n';
    seed('ruled.md', body);
    expect(new MemoryStore().readMemory('ruled')).toBe(body);
  });
});

describe('the round trip', () => {
  it('returns exactly what was written, with no front matter leaking into the body', () => {
    const store = new MemoryStore();
    const body = 'Two lines.\nSecond one.\n';
    store.writeMemory('note', body);
    expect(store.readMemory('note')).toBe(body);
    // And the fence really is on disk — otherwise this passes for the wrong
    // reason, by never having written metadata at all.
    expect(raw('note')).toMatch(/^---\n/);
    expect(raw('note')).toContain('key: note');
  });

  it('stamps writtenAt on write', () => {
    const before = Date.now();
    const store = new MemoryStore();
    store.writeMemory('note', 'x');
    const at = Date.parse(store.readRecord('note')!.writtenAt!);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('records the raw key, not the sanitized one', () => {
    const store = new MemoryStore();
    store.writeMemory('email accounts', 'x');
    expect(store.readRecord('email accounts')?.key).toBe('email accounts');
    expect(raw('email accounts')).toContain('key: email accounts');
  });

  it('keeps a body that opens with a rule readable through a real write', () => {
    const store = new MemoryStore();
    const body = '---\nnot metadata\n---\nbody\n';
    store.writeMemory('tricky', body);
    expect(store.readMemory('tricky')).toBe(body);
  });
});

describe('key collisions are refused, not silently overwritten', () => {
  it('refuses a different raw key that sanitizes onto an existing file', () => {
    // `sanitizeKey` DELETES rather than replaces, so "foo bar", "foobar" and
    // "foo/bar" all address foobar.md — and `writeMemory` used to overwrite
    // unconditionally. Two files on a real install are scars of exactly this.
    const store = new MemoryStore();
    store.writeMemory('foo bar', 'first');
    expect(() => store.writeMemory('foo/bar', 'second')).toThrow(MemoryKeyCollisionError);
    expect(store.readMemory('foo bar')).toBe('first');
  });

  it('names the memory that already owns the file', () => {
    const store = new MemoryStore();
    store.writeMemory('foo bar', 'first');
    expect(() => store.writeMemory('foobar', 'second')).toThrow(/foo bar/);
  });

  it('a key with literal quotes stays rewritable', async () => {
    // The write and read paths normalized asymmetrically: `splitFrontMatter`
    // strips one layer of surrounding quotes, and the writer did not. So a key
    // of `"foo"` was stored as `key: "foo"`, read back as `foo`, and every
    // later rewrite collided with itself — the record became permanently
    // un-rewritable, and the model's only escape was to invent a second key,
    // creating exactly the duplicate the check exists to prevent. Both sides go
    // through `normalizeFrontMatterValue` now.
    const store = new MemoryStore();
    store.writeMemory('"quoted"', 'first');
    expect(() => store.writeMemory('"quoted"', 'second')).not.toThrow();
    expect(store.readMemory('"quoted"')).toBe('second');
  });

  it('still refuses a genuinely different key on the same file', () => {
    // The normalization must not swallow the collision check it sits next to.
    // `foo bar` and `foo.bar` both sanitize to `foobar.md`, and neither is a
    // quoting variant of the other — so normalizing quotes must not make them
    // look like the same key.
    const store = new MemoryStore();
    store.writeMemory('foo bar', 'first');
    expect(() => store.writeMemory('foo.bar', 'second')).toThrow(MemoryKeyCollisionError);
  });

  it('still allows rewriting the same key', () => {
    const store = new MemoryStore();
    store.writeMemory('note', 'first');
    store.writeMemory('note', 'second');
    expect(store.readMemory('note')).toBe('second');
  });

  it('accepts a legacy target and stamps it, because the raw key was never recorded', () => {
    // The honest limit: a legacy file recorded nothing to compare against, so
    // its collision is undetectable. The hole closes per key on first write,
    // never retroactively — asserted rather than left to be discovered.
    seed('foobar.md', 'legacy');
    const store = new MemoryStore();
    expect(() => store.writeMemory('foo bar', 'new')).not.toThrow();
    expect(store.readRecord('foo bar')?.key).toBe('foo bar');
    expect(() => store.writeMemory('foobar', 'newer')).toThrow(MemoryKeyCollisionError);
  });
});

describe('supersession archives rather than deletes', () => {
  function twoNotes(): MemoryStoreType {
    const store = new MemoryStore();
    store.writeMemory('issue', 'look issue numbers up with gh');
    store.writeMemory('issue-3538', 'look issue numbers up with the gh CLI, including PRs');
    return store;
  }

  it('drops the retired key from listMemory but leaves the file on disk', () => {
    const store = twoNotes();
    expect(store.supersede('issue', 'issue-3538')).toBe(true);
    expect(store.listMemory()).toEqual(['issue-3538']);
    expect(realFs.existsSync(path.join(memDir, 'issue.md'))).toBe(true);
  });

  it('still reads the retired memory directly, and says what replaced it', () => {
    const store = twoNotes();
    store.supersede('issue', 'issue-3538');
    const record = store.readRecord('issue');
    expect(record?.supersededBy).toBe('issue-3538');
    expect(record?.content).toBe('look issue numbers up with gh');
  });

  it('keeps the retired key in listAllMemory', () => {
    const store = twoNotes();
    store.supersede('issue', 'issue-3538');
    expect(store.listAllMemory().sort()).toEqual(['issue', 'issue-3538']);
  });

  it('drops it from getAllMemoryContents, which is what stops it being rendered', () => {
    const store = twoNotes();
    store.supersede('issue', 'issue-3538');
    expect([...store.getAllMemoryContents().keys()]).toEqual(['issue-3538']);
  });

  it('is undone by removing one front-matter line', () => {
    // The whole argument for archiving over deleting: reversible by hand, and
    // costing zero context in the meantime because it is not rendered.
    const store = twoNotes();
    store.supersede('issue', 'issue-3538');
    const p = path.join(memDir, 'issue.md');
    realFs.writeFileSync(
      p,
      realFs
        .readFileSync(p, 'utf-8')
        .split('\n')
        .filter((l) => !l.startsWith('supersededBy:'))
        .join('\n'),
      'utf-8',
    );
    expect(new MemoryStore().listMemory().sort()).toEqual(['issue', 'issue-3538']);
  });

  it('does not un-retire a record when it is rewritten', () => {
    const store = twoNotes();
    store.supersede('issue', 'issue-3538');
    store.writeMemory('issue', 'edited');
    expect(store.readRecord('issue')?.supersededBy).toBe('issue-3538');
  });

  it('returns false for a key that does not exist', () => {
    const store = twoNotes();
    expect(store.supersede('nope', 'issue')).toBe(false);
  });

  it('refuses a replacement that does not exist', () => {
    // Otherwise the record is retired in favour of nothing readable — filtered
    // out of every listing, pointing at a key nobody can open.
    const store = twoNotes();
    expect(() => store.supersede('issue', 'ghost')).toThrow(/no memory with that key/);
  });

  it('refuses to supersede a record with itself', () => {
    const store = twoNotes();
    expect(() => store.supersede('issue', 'issue')).toThrow(/itself/);
  });

  it('refuses a cycle', () => {
    // A→B then B→A leaves BOTH retired and neither reachable: every entry
    // filtered out of listMemory, each pointing at the other.
    const store = twoNotes();
    store.supersede('issue', 'issue-3538');
    expect(() => store.supersede('issue-3538', 'issue')).toThrow(/cycle/);
    expect(store.listMemory()).toEqual(['issue-3538']);
  });
});

describe('the read cache', () => {
  it('does not re-read a file whose mtime has not moved', () => {
    // Asserted by changing the bytes and restoring the mtime, rather than by
    // spying: `memory.ts` holds a namespace import of `node:fs`, so a spy on
    // the namespace object is not reliably the binding it calls. Stale content
    // surviving IS the cache, observed through the public API.
    const store = new MemoryStore();
    store.writeMemory('note', 'body');

    // Pinned to a whole-second timestamp BEFORE the cache is primed.
    // `utimesSync` rounds away the sub-millisecond precision `stat.mtimeMs`
    // reports, so capturing a live mtime and restoring it afterwards yields a
    // different number and the cache misses for the wrong reason.
    const p = path.join(memDir, 'note.md');
    const pinned = new Date('2026-09-07T12:00:00.000Z');
    realFs.utimesSync(p, pinned, pinned);
    expect(store.readMemory('note')).toBe('body');

    // Same LENGTH as well as same mtime: the cache validates on both, so a
    // different-sized write is a legitimate miss and would pass this test for
    // the wrong reason.
    realFs.writeFileSync(p, realFs.readFileSync(p, 'utf-8').replace('body', 'BODY'), 'utf-8');
    realFs.utimesSync(p, pinned, pinned);

    expect(store.readMemory('note')).toBe('body');
    // And a fresh store, with no cache, sees the change — so the assertion
    // above is about caching rather than about the write having failed.
    expect(new MemoryStore().readMemory('note')).toBe('BODY');
  });

  it('re-reads a same-mtime write of a different size', () => {
    // Why `CacheEntry` carries `size` as well as `mtimeMs`, following
    // `apps/app-csp-grants.ts`'s `readCached`: mtime granularity can miss a
    // same-millisecond external write, and a cross-process writer is the exact
    // scenario this cache was built to catch. On mtime alone this returns the
    // stale body.
    const store = new MemoryStore();
    store.writeMemory('note', 'short');
    expect(store.readMemory('note')).toBe('short');

    const p = path.join(memDir, 'note.md');
    const pinned = new Date('2026-09-07T12:00:00.000Z');
    realFs.utimesSync(p, pinned, pinned);
    expect(store.readMemory('note')).toBe('short');

    realFs.writeFileSync(p, realFs.readFileSync(p, 'utf-8').replace('short', 'much longer body'));
    realFs.utimesSync(p, pinned, pinned);

    expect(store.readMemory('note')).toBe('much longer body');
  });

  it('re-reads when another process writes the same file', () => {
    // Validated by `stat` rather than invalidated by our own writes, because at
    // least four `new MemoryStore()` sites address the same directory — a
    // sibling's write has to be seen. This is the test that fails if the mtime
    // check is dropped in favour of a write-invalidated cache.
    const store = new MemoryStore();
    store.writeMemory('note', 'first');
    expect(store.readMemory('note')).toBe('first');

    const other = new MemoryStore();
    other.writeMemory('note', 'second');

    expect(store.readMemory('note')).toBe('second');
  });

  it('forgets a file that was deleted underneath it', () => {
    const store = new MemoryStore();
    store.writeMemory('note', 'body');
    expect(store.readMemory('note')).toBe('body');
    realFs.unlinkSync(path.join(memDir, 'note.md'));
    expect(store.readMemory('note')).toBeNull();
  });
});
