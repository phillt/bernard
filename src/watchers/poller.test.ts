import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { WatcherStore } from './store.js';
import { WatcherPoller } from './poller.js';
import { captureBaseline } from './probe.js';
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
  return attachMeta(
    { description: '', parameters: {} as never, execute: async () => result } as never,
    {
      name: 't',
      kind: 'read',
      deterministic: false,
      sideEffect: 'network',
    } as ToolMeta,
  );
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

  it('puts the watcher back when the consumer refuses the wake', async () => {
    // A watcher is marked terminal BEFORE delivery, so a wake sitting behind a
    // long turn cannot fire twice. Without a way to refuse, one full turn queue
    // would permanently spend the watcher the user was waiting on.
    const w = store.create({
      name: 'refused',
      target: { kind: 'file', path: '/watched' },
      predicate: { kind: 'changed' },
      instructions: 'react',
      ownerSessionId: 's1',
      snapshot: digestOf({ exists: false }),
    });
    let now = Date.now() + 120_000;
    const poller = new WatcherPoller({
      store,
      sessionId: 's1',
      deps: deps({ statFile: () => ({ mtimeMs: 1, size: 2 }) }),
      onWake: () => false,
      now: () => now,
    });

    await poller.tick();
    const after = store.read(w.id);
    expect(after?.status).toBe('active');
    expect(after?.firedAt).toBeUndefined();

    // And it fires again on the next due poll, rather than being lost.
    const accepted = vi.fn(() => true);
    now += 120_000;
    const second = new WatcherPoller({
      store,
      sessionId: 's1',
      deps: deps({ statFile: () => ({ mtimeMs: 1, size: 2 }) }),
      onWake: accepted,
      now: () => now,
    });
    await second.tick();
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(store.read(w.id)?.status).toBe('fired');
  });

  it('rewinds every field the fire advanced, not the ones somebody remembered', async () => {
    // Every field, not the five the old hand-written patch happened to name.
    // Those five were not what made it work: the other four came back because
    // `update` merges onto the `known` record it is handed, which was this same
    // held record. A repeating watcher is where the difference would bite —
    // `rearm` is the path that advances the HTTP validators — so a rewind that
    // stopped depending on `known` would leave the watcher holding an `etag` for
    // a body it never acted on, the next poll would send `If-None-Match` and
    // take the `304`, and the change the user was waiting for would never be
    // reported. Asserted per field rather than on the mechanism, so it holds
    // whichever way the rewind is written.
    const w = store.create({
      name: 'page',
      target: { kind: 'http', url: 'https://example.test/page' },
      predicate: { kind: 'changed' },
      instructions: 'react',
      ownerSessionId: 's1',
      repeating: true,
      snapshot: digestOf('old'),
      etag: 'W/"before"',
    });
    // A transient blip already on the record, so the reset the fire path applies
    // is visible as something that has to be put back too.
    store.update(w.id, { failureCount: 2 });

    const now = Date.now() + 120_000;
    const poller = new WatcherPoller({
      store,
      sessionId: 's1',
      deps: deps({
        fetch: (async () =>
          new Response('new body', { headers: { etag: 'W/"after"' } })) as unknown as typeof fetch,
      }),
      onWake: () => false,
      now: () => now,
    });

    await poller.tick();
    const after = store.read(w.id);
    expect(after?.status).toBe('active');
    expect(after?.etag).toBe('W/"before"');
    expect(after?.snapshot).toBe(digestOf('old'));
    expect(after?.fireCount).toBe(0);
    expect(after?.failureCount).toBe(2);
    // The one thing kept from the fire: we really did look.
    expect(after?.lastCheckedAt).toBe(new Date(now).toISOString());
  });

  it('names working idPaths when a live poll cannot read the predicate', async () => {
    // A watcher whose `idPath` names no list polls cleanly forever and can never
    // fire — the silent-inertness failure. The poll-time message used to be a
    // second hand-written copy of the creation-time one, minus the suggestions,
    // so the failure that strands a LIVE watcher was the one told nothing.
    const payload = { items: [{ id: 'a' }, { id: 'b' }] };
    const w = store.create({
      name: 'dead path',
      target: { kind: 'mcp', tool: 't', args: {} },
      // `$.messages.id` names nothing in `{items:[…]}` — the exact shape that
      // stranded three real watchers.
      predicate: { kind: 'appeared', idPath: '$.messages.id' },
      instructions: 'react',
      ownerSessionId: 's1',
      baselineIds: [],
    });
    let now = Date.now();
    const poller = new WatcherPoller({
      store,
      sessionId: 's1',
      deps: deps({ tools: () => ({ t: readTool(payload) }) }),
      onWake: vi.fn(),
      now: () => now,
    });

    await poller.tick();
    expect(store.read(w.id)?.lastError).toContain('$.items.id');

    // And it stops rather than polling blind forever.
    for (let i = 1; i < MAX_PROBE_FAILURES; i++) {
      now += 120_000;
      await poller.tick();
    }
    expect(store.read(w.id)?.status).toBe('failed');
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
      deps: deps({
        fetch: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
      }),
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
    const tool = readTool({
      content: [{ type: 'text', text: JSON.stringify({ m: [{ id: 'a' }] }) }],
    });
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

/**
 * Repeating watchers (#479 follow-up, from use).
 *
 * One-shot forced the agent to recreate a watcher after every fire — observed
 * six times on one chat. That costs a turn each time and, worse, leaves a GAP:
 * the new baseline is captured in a later turn, so anything that arrived in
 * between is already present and is never reported. Replies were lost in it.
 */
describe('WatcherPoller — repeating', () => {
  function chat(ids: string[]) {
    return deps({
      tools: () => ({
        t: readTool({
          content: [
            {
              type: 'text',
              text: JSON.stringify({ items: ids.map((id) => ({ id, mine: false })) }),
            },
          ],
        }),
      }),
    });
  }

  it('fires repeatedly and stays armed, advancing its own baseline', async () => {
    const w = store.create({
      name: 'chat',
      target: { kind: 'mcp', tool: 't', args: {} },
      predicate: { kind: 'appeared', idPath: '$.items.id' },
      instructions: 'react',
      ownerSessionId: 's1',
      repeating: true,
      baselineIds: ['1'],
    });
    const onWake = vi.fn(() => true);
    let now = Date.now();
    const poll = (d: ProbeDeps) =>
      new WatcherPoller({ store, sessionId: 's1', deps: d, onWake, now: () => now });

    now += 120_000;
    await poll(chat(['2', '1'])).tick();
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(store.read(w.id)?.status).toBe('active');
    expect(store.read(w.id)?.fireCount).toBe(1);

    // The second reply must fire too — this is what one-shot could not do.
    now += 120_000;
    await poll(chat(['3', '2', '1'])).tick();
    expect(onWake).toHaveBeenCalledTimes(2);
    expect(store.read(w.id)?.fireCount).toBe(2);

    // And an unchanged poll must NOT fire, or it would loop on itself.
    now += 120_000;
    await poll(chat(['3', '2', '1'])).tick();
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it('leaves no gap: the baseline advances in the poll that fired', async () => {
    // The re-arm gap in one assertion. Advancing from a LATER read would take
    // '3' into the baseline as already-seen and never report it.
    const w = store.create({
      name: 'chat',
      target: { kind: 'mcp', tool: 't', args: {} },
      predicate: { kind: 'appeared', idPath: '$.items.id' },
      instructions: 'react',
      ownerSessionId: 's1',
      repeating: true,
      baselineIds: ['1'],
    });
    let now = Date.now() + 120_000;
    const onWake = vi.fn(() => true);
    await new WatcherPoller({
      store,
      sessionId: 's1',
      deps: chat(['2', '1']),
      onWake,
      now: () => now,
    }).tick();
    expect(store.read(w.id)?.baselineIds).toEqual(['2', '1']);

    now += 120_000;
    await new WatcherPoller({
      store,
      sessionId: 's1',
      deps: chat(['3', '2', '1']),
      onWake,
      now: () => now,
    }).tick();
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it('stops itself at maxFires rather than running away', async () => {
    const w = store.create({
      name: 'chat',
      target: { kind: 'mcp', tool: 't', args: {} },
      predicate: { kind: 'appeared', idPath: '$.items.id' },
      instructions: 'react',
      ownerSessionId: 's1',
      repeating: true,
      maxFires: 2,
      baselineIds: [],
    });
    let now = Date.now();
    const onWake = vi.fn(() => true);
    for (const ids of [['1'], ['2', '1'], ['3', '2', '1']]) {
      now += 120_000;
      await new WatcherPoller({
        store,
        sessionId: 's1',
        deps: chat(ids),
        onWake,
        now: () => now,
      }).tick();
    }
    expect(store.read(w.id)?.status).toBe('fired');
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it('does not advance the baseline when the wake is refused', async () => {
    const w = store.create({
      name: 'chat',
      target: { kind: 'mcp', tool: 't', args: {} },
      predicate: { kind: 'appeared', idPath: '$.items.id' },
      instructions: 'react',
      ownerSessionId: 's1',
      repeating: true,
      baselineIds: ['1'],
    });
    const now = Date.now() + 120_000;
    await new WatcherPoller({
      store,
      sessionId: 's1',
      deps: chat(['2', '1']),
      onWake: () => false,
      now: () => now,
    }).tick();
    // Rewound: leaving it advanced would mean '2' never counts as new again.
    expect(store.read(w.id)?.baselineIds).toEqual(['1']);
    expect(store.read(w.id)?.fireCount ?? 0).toBe(0);
    expect(store.read(w.id)?.status).toBe('active');
  });
});

describe('appeared — the where filter', () => {
  it('ignores items the filter excludes, so your own reply cannot wake you', async () => {
    // Beeper returns your OWN sent messages (isSender: true). Without this a
    // watcher on a chat fires on Bernard's reply, which prompts another reply.
    const mixed = (items: { id: string; isSender: boolean }[]) =>
      deps({
        tools: () => ({
          t: readTool({ content: [{ type: 'text', text: JSON.stringify({ items }) }] }),
        }),
      });
    const w = store.create({
      name: 'chat',
      target: { kind: 'mcp', tool: 't', args: {} },
      predicate: {
        kind: 'appeared',
        idPath: '$.items.id',
        where: { path: 'isSender', equals: false },
      },
      instructions: 'react',
      ownerSessionId: 's1',
      repeating: true,
      baselineIds: ['1'],
    });
    const onWake = vi.fn(() => true);
    let now = Date.now() + 120_000;

    // Bernard's own message arrives: must NOT fire.
    await new WatcherPoller({
      store,
      sessionId: 's1',
      deps: mixed([
        { id: '2', isSender: true },
        { id: '1', isSender: false },
      ]),
      onWake,
      now: () => now,
    }).tick();
    expect(onWake).not.toHaveBeenCalled();

    // Someone else replies: must fire.
    now += 120_000;
    await new WatcherPoller({
      store,
      sessionId: 's1',
      deps: mixed([
        { id: '3', isSender: false },
        { id: '2', isSender: true },
        { id: '1', isSender: false },
      ]),
      onWake,
      now: () => now,
    }).tick();
    expect(onWake).toHaveBeenCalledTimes(1);
  });
});
