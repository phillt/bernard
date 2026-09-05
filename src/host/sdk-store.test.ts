import { describe, it, expect } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';
import { appletSdkScript } from './sdk.js';

/**
 * What a `bernard.store.*` call actually resolves to, run against the REAL
 * route and a real store.
 *
 * Its own file rather than an addition to `sdk.test.ts`, which touches no disk
 * — `handleStoreRequest` builds its own SQLite store from the app id, so this
 * one needs a temp home.
 *
 * Written after an applet lost half an hour to the gap it closes. `store.get`
 * resolved to the wire envelope `{key, value, updatedAt}` while both shipped
 * documents showed it returning the value; the page did `setItems(saved || [])`
 * and then `items.map(...)` — a TypeError against an entry — and the Save
 * button silently did nothing. Nothing in the suite could have caught it:
 * `sdk.test.ts` asserted the store's key NAMES and nothing about behaviour.
 *
 * Deliberately NOT a stub of the route. `handleStoreRequest` is what decides
 * the envelope, so stubbing it would let the two drift in exactly the way this
 * exists to prevent.
 *
 * This is also the honest form of "execute the doc's snippet against the real
 * route": aimed at the SDK rather than at prose, because running the
 * `applet-ui-runtime` example for real would mean standing up Preact, htm and a
 * DOM, and most of its failures would be fixture failures.
 */
interface StoreClient {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
  list(prefix?: string, opts?: { limit?: number; after?: string }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

describe('what a store call resolves to', () => {
  useTempHome('bernard-sdk-store');

  // A fresh app id per call: the store is real and on disk, so a shared id
  // leaks keys between tests — which is how the pagination assertion first
  // failed, seeing a neighbour's row.
  let n = 0;
  async function client(): Promise<StoreClient> {
    const appId = `sdk-store-${n++}`;
    const vm = await import('node:vm');
    const { handleStoreRequest } = await import('./store-route.js');
    const ctx: Record<string, unknown> = {
      window: {} as Record<string, unknown>,
      addEventListener() {},
      document: { getElementById: () => null },
      fetch: async (url: string, init?: { body?: string }) => {
        if (String(url).includes('bootstrap')) {
          return { ok: true, status: 200, json: async () => ({ appId, token: 't' }) };
        }
        const res = handleStoreRequest(appId, JSON.parse(init?.body ?? '{}'));
        return { ok: true, status: 200, json: async () => res };
      },
    };
    vm.createContext(ctx);
    new vm.Script(appletSdkScript()).runInContext(ctx);
    return (ctx.window as { bernard: { store: StoreClient } }).bernard.store;
  }

  it('get returns the value, not the entry that carries it', async () => {
    const store = await client();
    await store.set('items', [1, 2]);
    const got = await store.get('items');
    expect(got).toEqual([1, 2]);
    // The assertion that actually bites on a revert: an entry is truthy and
    // deep-equals nothing useful, but it carries `updatedAt`.
    expect(got).not.toHaveProperty('updatedAt');
  });

  it('get returns null for a key that is not there', async () => {
    // An entry object is truthy, so before this `if (saved)` passed on a miss.
    expect(await (await client()).get('nope')).toBeNull();
  });

  it('cannot tell a missing key from a stored null — the one named cost', async () => {
    // Pinned rather than left to a comment. A caller that must distinguish
    // uses `list(key)` and checks the length, which is why `list` keeps
    // entries.
    const store = await client();
    await store.set('k', null);
    expect(await store.get('k')).toBeNull();
    expect((await store.list('k')) as unknown[]).toHaveLength(1);
  });

  it('set returns the value it wrote', async () => {
    expect(await (await client()).set('k', { a: 1 })).toEqual({ a: 1 });
  });

  it('delete returns a boolean, not a { deleted } wrapper', async () => {
    // `{deleted:false}` is truthy, so the wrapper made every delete look like
    // it had worked.
    const store = await client();
    await store.set('k', 1);
    expect(await store.delete('k')).toBe(true);
    expect(await store.delete('k')).toBe(false);
  });

  it('list KEEPS its entries, because a prefix listing needs the keys', async () => {
    // Deliberately not unwrapped for symmetry with `get`: that would trade a
    // real leak for a real loss.
    const store = await client();
    await store.set('note:a', 1);
    await store.set('note:b', 2);
    await store.set('other', 3);
    const rows = (await store.list('note:')) as { key: string; value: unknown }[];
    expect(rows.map((r) => r.key)).toEqual(['note:a', 'note:b']);
    expect(rows.map((r) => r.value)).toEqual([1, 2]);
    expect(rows[0]).toHaveProperty('updatedAt');
  });

  it('forwards limit and after, which the client used to drop', async () => {
    // The route and `AppletStore.list` both support them; the client sent only
    // `prefix`, so a page with more than DEFAULT_LIST_LIMIT entries silently
    // got a truncated list and could not tell.
    const store = await client();
    for (const k of ['a', 'b', 'c']) await store.set(k, k);
    const first = (await store.list('', { limit: 2 })) as { key: string }[];
    expect(first.map((r) => r.key)).toEqual(['a', 'b']);
    const rest = (await store.list('', { limit: 2, after: 'b' })) as { key: string }[];
    expect(rest.map((r) => r.key)).toEqual(['c']);
  });
});
