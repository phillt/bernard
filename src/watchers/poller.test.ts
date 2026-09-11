import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { WatcherStore } from './store.js';
import { WatcherPoller, captureBaseline } from './poller.js';
import { digestOf } from './evaluate.js';
import { MAX_PROBE_FAILURES } from './types.js';
import type { ProbeDeps } from './probe.js';
import { attachMeta } from '../framework/tools/adapter.js';
import type { ToolMeta } from '../framework/tools/types.js';

/**
 * Real store on a temp home, injected probe deps — no network, no MCP, no clock
 * sleeping. Time is a function so "eleven missed polls" costs nothing.
 */
function readTool(result: unknown) {
  return attachMeta({ description: '', parameters: {} as never, execute: async () => result } as never, {
    name: 't',
    kind: 'read',
    deterministic: false,
    sideEffect: 'network',
  } as ToolMeta);
}

function deps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    fetch: (async () => new Response('body')) as unknown as typeof fetch,
    statFile: () => null,
    tools: () => ({}),
    ...over,
  };
}

let store: WatcherStore;

beforeEach(() => {
  // `setup-test-home.ts` gives every test FILE its own BERNARD_HOME, so this is
  // only per-test isolation within the file. Through the store rather than
  // `readdirSync`, which would have to exist first.
  store = new WatcherStore();
  for (const w of store.list()) store.remove(w.id);
});

afterEach(() => vi.clearAllMocks());

describe('WatcherPoller', () => {
  it('fires once, marks the watcher terminal, and does not fire again', async () => {
    // Terminal BEFORE the wake is delivered: a wake can sit behind a long turn,
    // and a watcher left active would fire again on the next tick. The user
    // asked to be told once.
    const w = store.create({
      name: 'file appears',
      target: { kind: 'file', path: '/watched' },
      predicate: { kind: 'changed' },
      instructions: 'react',
      ownerSessionId: 's1',
      snapshot: digestOf({ exists: false }),
    });

    const onWake = vi.fn();
    let now = Date.now() + 120_000;
    const poller = new WatcherPoller({
      store,
      sessionId: 's1',
      deps: deps({ statFile: () => ({ mtimeMs: 1, size: 2 }) }),
      onWake,
      now: () => now,
    });

    await poller.tick();
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(store.read(w.id)?.status).toBe('fired');

    now += 120_000;
    await poller.tick();
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('is level-triggered: eleven missed polls still fire on the twelfth', async () => {
    // The property the design rests on. Nothing counts polls — the comparison is
    // against the snapshot, so the gap is irrelevant. This is why #400 is not a
    // prerequisite.
    const w = store.create({
      name: 'page',
      target: { kind: 'http', url: 'https://e.com' },
      predicate: { kind: 'changed' },
      instructions: 'react',
      ownerSessionId: 's1',
      snapshot: digestOf('v1'),
    });
    const onWake = vi.fn();
    const poller = new WatcherPoller({
      store,
      sessionId: 's1',
      deps: deps({ fetch: (async () => new Response('v12')) as unknown as typeof fetch }),
      onWake,
      // Twelve intervals later, having ticked zero times in between.
      now: () => Date.parse(w.createdAt) + 12 * 60_000,
    });

    await poller.tick();
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('does not poll a watcher that is not due', async () => {
    const w = store.create({
      name: 'page',
      target: { kind: 'http', url: 'https://e.com' },
      predicate: { kind: 'changed' },
      instructions: 'react',
      ownerSessionId: 's1',
      snapshot: digestOf('v1'),
    });
    store.update(w.id, { lastCheckedAt: new Date().toISOString() });
    const fetchMock = vi.fn(async () => new Response('v2'));
    const poller = new WatcherPoller({
      store,
      sessionId: 's1',
      deps: deps({ fetch: fetchMock as unknown as typeof fetch }),
      onWake: vi.fn(),
    });
    await poller.tick();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives up after consecutive failures instead of retrying forever', async () => {
    // A watcher that has been failing all day is not watching anything, and the
    // user believes it is.
    const w = store.create({
      name: 'broken',
      target: { kind: 'http', url: 'https://e.com' },
      predicate: { kind: 'changed' },
      instructions: 'react',
      ownerSessionId: 's1',
      snapshot: 'x',
    });
    let now = Date.now();
    const poller = new WatcherPoller({
      store,
      sessionId: 's1',
      deps: deps({ fetch: (async () => new Response('', { status: 500 })) as unknown as typeof fetch }),
      onWake: vi.fn(),
      now: () => now,
    });
    for (let i = 0; i < MAX_PROBE_FAILURES; i++) {
      now += 120_000;
      await poller.tick();
    }
    const after = store.read(w.id);
    expect(after?.status).toBe('failed');
    expect(after?.lastError).toMatch(/HTTP 500/);
  });

  it('resets the failure count after a success, so failures must be consecutive', async () => {
    const w = store.create({
      name: 'flaky',
      target: { kind: 'http', url: 'https://e.com' },
      predicate: { kind: 'changed' },
      instructions: 'react',
      ownerSessionId: 's1',
      snapshot: digestOf('v1'),
    });
    store.update(w.id, { failureCount: 3 });
    const now = Date.now() + 120_000;
    const poller = new WatcherPoller({
      store,
      sessionId: 's1',
      deps: deps({ fetch: (async () => new Response('v1')) as unknown as typeof fetch }),
      onWake: vi.fn(),
      now: () => now,
    });
    await poller.tick();
    expect(store.read(w.id)?.failureCount).toBe(0);
  });

  it('only polls watchers this session owns', async () => {
    store.create({
      name: 'someone elses',
      target: { kind: 'http', url: 'https://e.com' },
      predicate: { kind: 'changed' },
      instructions: 'react',
      ownerSessionId: 'OTHER',
      snapshot: digestOf('v1'),
    });
    const fetchMock = vi.fn(async () => new Response('v2'));
    const poller = new WatcherPoller({
      store,
      sessionId: 's1',
      deps: deps({ fetch: fetchMock as unknown as typeof fetch }),
      onWake: vi.fn(),
    });
    await poller.tick();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adopts a watcher whose owning session is gone', async () => {
    // Otherwise the record exists, reads as active in `/watchers`, and will
    // never fire again — the silent failure this feature exists to remove.
    const w = store.create({
      name: 'orphan',
      target: { kind: 'http', url: 'https://e.com' },
      predicate: { kind: 'changed' },
      instructions: 'react',
      ownerSessionId: 'DEAD',
      snapshot: digestOf('v1'),
    });
    // A pid that cannot be alive.
    store.update(w.id, { ownerPid: 2 ** 30 });

    const poller = new WatcherPoller({ store, sessionId: 's1', deps: deps(), onWake: vi.fn() });
    poller.start();
    poller.stop();
    await Promise.resolve();

    expect(store.read(w.id)?.ownerSessionId).toBe('s1');
    expect(store.read(w.id)?.ownerPid).toBe(process.pid);
  });

  it('never throws out of a tick', async () => {
    const poller = new WatcherPoller({
      store,
      sessionId: 's1',
      deps: deps({
        tools: () => {
          throw new Error('registry exploded');
        },
      }),
      onWake: vi.fn(),
    });
    store.create({
      name: 'x',
      target: { kind: 'mcp', tool: 't', args: {} },
      predicate: { kind: 'changed' },
      instructions: 'react',
      ownerSessionId: 's1',
      snapshot: 'x',
    });
    await expect(poller.tick()).resolves.toBeUndefined();
  });

  it('looks once immediately on start rather than waiting a full tick', async () => {
    // A watcher whose `time` target came due while no session was running should
    // not wait for the interval — the first thing a user does after restarting
    // is ask why nothing happened.
    store.create({
      name: 'due',
      target: { kind: 'time', at: new Date(Date.now() - 1000).toISOString() },
      predicate: { kind: 'changed' },
      instructions: 'react',
      ownerSessionId: 's1',
    });
    const onWake = vi.fn();
    const poller = new WatcherPoller({ store, sessionId: 's1', deps: deps(), onWake });
    poller.start();
    await new Promise((r) => setTimeout(r, 10));
    poller.stop();
    expect(onWake).toHaveBeenCalledTimes(1);
  });
});

describe('captureBaseline', () => {
  it('captures at creation so a changed watcher does not fire immediately', async () => {
    const got = await captureBaseline(
      { kind: 'http', url: 'https://e.com' },
      { kind: 'changed' },
      deps({ fetch: (async () => new Response('current')) as unknown as typeof fetch }),
    );
    expect(got).toMatchObject({ ok: true, snapshot: digestOf('current') });
  });

  it('captures the current id set for an appeared watcher', async () => {
    const tool = readTool({ content: [{ type: 'text', text: JSON.stringify({ m: [{ id: 'a' }] }) }] });
    const got = await captureBaseline(
      { kind: 'mcp', tool: 't', args: {} },
      { kind: 'appeared', idPath: '$.m.id' },
      deps({ tools: () => ({ t: tool }) }),
    );
    expect(got).toMatchObject({ ok: true, baselineIds: ['a'] });
  });

  it('reports a failed baseline rather than creating a blind watcher', async () => {
    const got = await captureBaseline(
      { kind: 'http', url: 'https://e.com' },
      { kind: 'changed' },
      deps({ fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch }),
    );
    expect(got).toMatchObject({ ok: false });
  });

  it('needs no probe for a time target', async () => {
    const fetchMock = vi.fn();
    const got = await captureBaseline(
      { kind: 'time', at: new Date().toISOString() },
      { kind: 'changed' },
      deps({ fetch: fetchMock as unknown as typeof fetch }),
    );
    expect(got).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
