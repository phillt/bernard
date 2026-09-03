import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from '../__tests__/temp-home.js';

async function load() {
  vi.resetModules();
  const paths = await import('../paths.js');
  const store = await import('./store.js');
  return { ...store, appletDataDir: paths.appletDataDir };
}

describe('AppletStore (#422)', () => {
  useTempHome('bernard-applet-store');

  it('round-trips a structured value', async () => {
    const m = await load();
    const s = new m.AppletStore('notes');
    s.set('draft', { title: 'hi', tags: ['a', 'b'], done: false });
    expect(s.get('draft')?.value).toEqual({ title: 'hi', tags: ['a', 'b'], done: false });
    s.close();
  });

  // The property that makes it a store at all: the host restarts, the page
  // reloads, the data is still there.
  it('survives a reopen', async () => {
    const m = await load();
    const a = new m.AppletStore('notes');
    a.set('k', 1);
    a.close();
    const b = new m.AppletStore('notes');
    expect(b.get('k')?.value).toBe(1);
    b.close();
  });

  it('overwrites on set and reports a missing key as null', async () => {
    const m = await load();
    const s = new m.AppletStore('notes');
    s.set('k', 'first');
    s.set('k', 'second');
    expect(s.get('k')?.value).toBe('second');
    expect(s.get('nope')).toBeNull();
    expect(s.delete('k')).toBe(true);
    expect(s.delete('k')).toBe(false);
    s.close();
  });

  it('lists in key order, honours a prefix, and pages with a cursor', async () => {
    const m = await load();
    const s = new m.AppletStore('notes');
    for (const k of ['a:1', 'a:2', 'a:3', 'b:1']) s.set(k, k);
    expect(s.list({ prefix: 'a:' }).map((e) => e.key)).toEqual(['a:1', 'a:2', 'a:3']);
    expect(s.list({ prefix: 'a:', limit: 2 }).map((e) => e.key)).toEqual(['a:1', 'a:2']);
    expect(s.list({ prefix: 'a:', after: 'a:2' }).map((e) => e.key)).toEqual(['a:3']);
    s.close();
  });

  // The caller's prefix is text, not a pattern. `%` is a LIKE wildcard and
  // would otherwise match everything.
  it('treats a prefix as literal text, never a pattern', async () => {
    const m = await load();
    const s = new m.AppletStore('notes');
    s.set('real', 1);
    s.set('%odd', 2);
    expect(s.list({ prefix: '%' }).map((e) => e.key)).toEqual(['%odd']);
    s.close();
  });

  it('bounds keys and values', async () => {
    const m = await load();
    const s = new m.AppletStore('notes');
    expect(() => s.set('', 1)).toThrow();
    expect(() => s.set('k'.repeat(m.MAX_KEY_LENGTH + 1), 1)).toThrow();
    expect(() => s.set('big', 'x'.repeat(m.MAX_VALUE_BYTES + 10))).toThrow(/bytes/);
    s.close();
  });

  // The id becomes a directory name; a repaired one would address a different
  // store than the caller named.
  it('rejects an app id that is not one', async () => {
    const m = await load();
    expect(() => new m.AppletStore('../../etc')).toThrow();
    expect(() => new m.AppletStore('Not An Id')).toThrow();
  });

  it('keeps apps separate, in their own directories', async () => {
    const m = await load();
    const a = new m.AppletStore('notes');
    const b = new m.AppletStore('todo');
    a.set('k', 'notes-value');
    b.set('k', 'todo-value');
    expect(a.get('k')?.value).toBe('notes-value');
    expect(b.get('k')?.value).toBe('todo-value');
    expect(fs.existsSync(path.join(m.appletDataDir('notes'), 'data.db'))).toBe(true);
    a.close();
    b.close();
  });

  /**
   * The two-process shape this store lives in — the host serving the page and
   * an agent dispatch running an action. Two real connections rather than one
   * that hopes: `node:sqlite`'s busy timeout defaults to 0, so without WAL and
   * an explicit timeout this is where `SQLITE_BUSY` shows up.
   */
  it('two open connections do not deadlock', async () => {
    const m = await load();
    const writer = new m.AppletStore('notes');
    const reader = new m.AppletStore('notes');
    writer.set('k', 'v1');
    expect(reader.get('k')?.value).toBe('v1');
    reader.set('k', 'v2');
    expect(writer.get('k')?.value).toBe('v2');
    writer.close();
    reader.close();
  });

  // Serving the database over HTTP, or letting `file_write` corrupt it, are
  // both prevented by where it is — not by a check somewhere.
  it('lives outside both the served assets and the action write scope', async () => {
    const m = await load();
    const paths = await import('../paths.js');
    const data = m.appletDataDir('notes');
    expect(data.startsWith(paths.appletAssetDir('notes'))).toBe(false);
    expect(data.startsWith(paths.runWorkspace('apps', 'notes'))).toBe(false);
  });
});
