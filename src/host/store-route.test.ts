import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';

async function load() {
  vi.resetModules();
  return await import('./store-route.js');
}

describe('the applet store route (#422)', () => {
  useTempHome('bernard-store-route');

  it('round-trips through the request vocabulary', async () => {
    const m = await load();
    expect(m.handleStoreRequest('notes', { op: 'set', key: 'k', value: { n: 1 } })).toMatchObject({
      ok: true,
    });
    // The VALUE, not the entry that carries it. The route is the one and only
    // unwrap now: `sdk.ts` used to do a second one, justified by a wire
    // contract that has no other readers — a page speaking this endpoint
    // directly is refused at the write path.
    expect(m.handleStoreRequest('notes', { op: 'get', key: 'k' })).toMatchObject({
      ok: true,
      result: { n: 1 },
    });
    expect(m.handleStoreRequest('notes', { op: 'list' })).toMatchObject({ ok: true });
    expect(m.handleStoreRequest('notes', { op: 'delete', key: 'k' })).toMatchObject({
      ok: true,
      result: true,
    });
    m.closeAppletStore('notes');
  });

  // The vocabulary is closed. There is no op that takes anything interpretable.
  it('refuses an unknown op rather than guessing', async () => {
    const m = await load();
    expect(m.handleStoreRequest('notes', { op: 'exec', sql: 'DROP TABLE kv' })).toEqual({
      ok: false,
      error: expect.stringContaining('Unknown op'),
    });
    expect(m.handleStoreRequest('notes', {})).toMatchObject({ ok: false });
    m.closeAppletStore('notes');
  });

  it('reports a bad argument as an error rather than throwing', async () => {
    const m = await load();
    expect(m.handleStoreRequest('notes', { op: 'get' })).toEqual({
      ok: false,
      error: expect.stringContaining('key'),
    });
    m.closeAppletStore('notes');
  });

  // The appId is the server's own; a page cannot reach another applet's data
  // because there is no request field that names one.
  it('keeps each app to its own store', async () => {
    const m = await load();
    m.handleStoreRequest('notes', { op: 'set', key: 'k', value: 'notes' });
    m.handleStoreRequest('todo', { op: 'set', key: 'k', value: 'todo' });
    expect(m.handleStoreRequest('notes', { op: 'get', key: 'k' })).toMatchObject({
      result: 'notes',
    });
    expect(m.handleStoreRequest('todo', { op: 'get', key: 'k' })).toMatchObject({
      result: 'todo',
    });
    m.closeAppletStore('notes');
    m.closeAppletStore('todo');
  });
});
