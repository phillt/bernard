import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createWatcherTool } from './watcher.js';
import { WatcherStore } from '../watchers/store.js';
import { attachMeta } from '../framework/tools/adapter.js';
import type { ToolMeta } from '../framework/tools/types.js';

function tool(kind: ToolMeta['kind'], result: unknown = { messages: [{ id: 'm1' }] }) {
  return attachMeta(
    { description: '', parameters: {} as never, execute: async () => result } as never,
    { name: 't', kind, deterministic: false, sideEffect: 'network' } as ToolMeta,
  );
}

function make(tools: Record<string, unknown> = {}) {
  return createWatcherTool({ tools: () => tools, sessionId: () => 'sess-1' }).watcher;
}

const run = async (t: ReturnType<typeof make>, args: Record<string, unknown>) =>
  (await (t as { execute: (a: unknown, o: unknown) => Promise<string> }).execute(args, {
    toolCallId: 'c',
    messages: [],
  })) as string;

beforeEach(() => {
  const store = new WatcherStore();
  for (const w of store.list()) store.remove(w.id);
});

describe('watcher tool', () => {
  it('creates a time watcher and reports it', async () => {
    const out = await run(make(), {
      action: 'create',
      name: 'check back',
      instructions: 'see if the deploy settled',
      targetKind: 'time',
      at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(out).toMatch(/Watching at /);
    expect(new WatcherStore().list()).toHaveLength(1);
  });

  it('refuses a watcher on a WRITE tool, before creating anything', async () => {
    // The escalation this gate exists for: a watcher runs unattended and
    // repeatedly, so a write target would make something happen on a loop with
    // nobody looking.
    const out = await run(make({ gmail_send: tool('write') }), {
      action: 'create',
      name: 'bad',
      instructions: 'x',
      targetKind: 'mcp',
      tool: 'gmail_send',
    });
    expect(out).toMatch(/not a read-only tool/);
    expect(new WatcherStore().list()).toHaveLength(0);
  });

  it('captures a baseline at creation so a changed watcher does not fire at once', async () => {
    await run(make({ gmail_list: tool('read') }), {
      action: 'create',
      name: 'mail',
      instructions: 'react',
      targetKind: 'mcp',
      tool: 'gmail_list',
      predicate: 'changed',
    });
    expect(new WatcherStore().list()[0].snapshot).toBeTruthy();
  });

  it('captures the current id set for an appeared watcher', async () => {
    await run(make({ gmail_list: tool('read') }), {
      action: 'create',
      name: 'mail',
      instructions: 'react',
      targetKind: 'mcp',
      tool: 'gmail_list',
      predicate: 'appeared',
      idPath: '$.messages.id',
    });
    expect(new WatcherStore().list()[0].baselineIds).toEqual(['m1']);
  });

  it('refuses to create when the target cannot be read', async () => {
    // A watcher whose baseline failed is blind: it would compare against
    // nothing and fire on its first poll, reporting a change that never
    // happened.
    const out = await run(make({ gmail_list: tool('read') }), {
      action: 'create',
      name: 'mail',
      instructions: 'react',
      targetKind: 'mcp',
      tool: 'missing_tool',
    });
    expect(out).toMatch(/Error/);
    expect(new WatcherStore().list()).toHaveLength(0);
  });

  it('names the missing field rather than failing vaguely', async () => {
    const t = make();
    expect(await run(t, { action: 'create', name: 'x', targetKind: 'time' })).toMatch(
      /`instructions` is required/,
    );
    expect(
      await run(t, { action: 'create', name: 'x', instructions: 'y', targetKind: 'time' }),
    ).toMatch(/needs `at`/);
    expect(
      await run(t, {
        action: 'create',
        name: 'x',
        instructions: 'y',
        targetKind: 'file',
      }),
    ).toMatch(/needs `watchPath`/);
  });

  it('rejects an unparseable regex instead of storing a watcher that can never fire', async () => {
    const out = await run(make({ g: tool('read') }), {
      action: 'create',
      name: 'x',
      instructions: 'y',
      targetKind: 'mcp',
      tool: 'g',
      predicate: 'matches',
      pattern: '([',
    });
    expect(out).toMatch(/not a valid regular expression/);
  });

  it('lists and cancels', async () => {
    const t = make();
    await run(t, {
      action: 'create',
      name: 'one',
      instructions: 'x',
      targetKind: 'time',
      at: new Date(Date.now() + 1000).toISOString(),
    });
    const id = new WatcherStore().list()[0].id;
    expect(await run(t, { action: 'list' })).toMatch(/one/);
    expect(await run(t, { action: 'cancel', id })).toMatch(/Cancelled "one"/);
    expect(new WatcherStore().read(id)?.status).toBe('cancelled');
    // Cancelling twice reports the state rather than pretending it acted.
    expect(await run(t, { action: 'cancel', id })).toMatch(/already cancelled/);
  });

  it('does not leak the digest or a full id set through get', async () => {
    const t = make({ g: tool('read') });
    await run(t, {
      action: 'create',
      name: 'x',
      instructions: 'y',
      targetKind: 'mcp',
      tool: 'g',
      predicate: 'appeared',
      idPath: '$.messages.id',
    });
    const id = new WatcherStore().list()[0].id;
    const out = await run(t, { action: 'get', id });
    expect(out).toMatch(/1 ids/);
    expect(out).not.toMatch(/"m1"/);
  });

  it('returns an error for an unknown action rather than undefined', async () => {
    // A direct `execute` bypasses zod, and `undefined` reads as success to
    // `detectResultFailure`.
    expect(await run(make(), { action: 'nope' })).toMatch(/unknown action/);
  });

  it('floors a too-frequent interval instead of honouring it', async () => {
    await run(make(), {
      action: 'create',
      name: 'fast',
      instructions: 'x',
      targetKind: 'time',
      at: new Date(Date.now() + 1000).toISOString(),
      intervalSeconds: 1,
    });
    expect(new WatcherStore().list()[0].intervalMs).toBeGreaterThanOrEqual(15_000);
  });
});

/**
 * The delegated-registry regression (#479 follow-up).
 *
 * Observed in a real session: Bernard chose exactly the right tool and shape —
 * `beeper_…__list_messages` with an `mcp` target — and was told
 * "No tool named ... is available in this session." He fell back to a blind
 * `time` watcher, which polls a clock instead of the thing that was asked about.
 *
 * The cause was that create-time validation read the registry `createTools` was
 * HANDED, and with `BERNARD_MCP_DELEGATION` on — the default — that holds
 * `delegate_<server>` tools and none of the real `server_hash__tool` names. The
 * poller reads `snapshot().tools`, which is raw. So the two disagreed, and
 * validation refused a tool the poller could have called.
 */
describe('watcher tool — registry agreement', () => {
  const raw = { beeper_ab12__list_messages: tool('read') };
  const delegated = { delegate_beeper: tool('write') };

  it('validates against the RAW bag, not the delegated surface', async () => {
    const out = await run(make(raw), {
      action: 'create',
      name: 'kaitlyn reply',
      instructions: 'read the newest messages and respond',
      targetKind: 'mcp',
      tool: 'beeper_ab12__list_messages',
      predicate: 'appeared',
      idPath: '$.messages.id',
    });
    expect(out).toMatch(/Watching tool beeper_ab12__list_messages/);
  });

  it('reproduces the failure when handed the delegated bag', async () => {
    // Guard-the-guard: without this the test above could pass for the wrong
    // reason (e.g. if the refusal were removed entirely).
    const out = await run(make(delegated), {
      action: 'create',
      name: 'kaitlyn reply',
      instructions: 'x',
      targetKind: 'mcp',
      tool: 'beeper_ab12__list_messages',
    });
    expect(out).toMatch(/No tool named/);
  });

  it('names watchable alternatives instead of leaving the model guessing', async () => {
    const registry = {
      beeper_ab12__list_messages: tool('read'),
      beeper_ab12__read_messages: tool('read'),
      beeper_ab12__send_message: tool('write'),
    };
    const out = await run(make(registry), {
      action: 'create',
      name: 'x',
      instructions: 'y',
      targetKind: 'mcp',
      tool: 'beeper_ab12__get_messages',
    });
    expect(out).toMatch(/beeper_ab12__list_messages/);
    // Never suggests something the very next check would refuse.
    expect(out).not.toMatch(/send_message/);
  });

  it('points at the real name when a delegate tool was named', async () => {
    const out = await run(make(delegated), {
      action: 'create',
      name: 'x',
      instructions: 'y',
      targetKind: 'mcp',
      tool: 'delegate_beeper',
    });
    expect(out).toMatch(/not a read-only tool|delegate_<server>/);
  });
});

/**
 * The WIRING, which the cases above cannot pin.
 *
 * They inject their own registry, so they stay green even when `createTools`
 * hands the watcher the delegated bag — which is precisely the bug that shipped.
 * Mutation-checked: restoring `tools: () => mcpTools` fails this and nothing
 * else in the file.
 */
describe('createTools wires the watcher to the raw MCP bag', () => {
  it('accepts a real MCP tool name even when the surface is delegated', async () => {
    const { setActiveMCPManager } = await import('../mcp.js');
    const { createTools } = await import('./index.js');
    const { MemoryStore } = await import('../memory.js');

    const rawName = 'beeper_ab12__list_messages';
    // The live manager exposes RAW names, exactly as `snapshot()` does.
    const fakeManager = {
      snapshot: () => ({ tools: { [rawName]: tool('read') } }),
    };
    setActiveMCPManager(fakeManager as never);
    try {
      // …while `createTools` is handed the DELEGATED surface, as it is in a real
      // session with `BERNARD_MCP_DELEGATION` on.
      const registry = await createTools({} as never, new MemoryStore(), {
        delegate_beeper: tool('write'),
      } as never);
      const watcherTool = registry.watcher as {
        execute: (a: unknown, o: unknown) => Promise<string>;
      };
      const out = await watcherTool.execute(
        {
          action: 'create',
          name: 'kaitlyn reply',
          instructions: 'read the newest messages and respond',
          targetKind: 'mcp',
          tool: rawName,
          predicate: 'appeared',
          idPath: '$.messages.id',
        },
        { toolCallId: 'c', messages: [] },
      );
      expect(out).toMatch(/Watching tool beeper_ab12__list_messages/);
      expect(out).not.toMatch(/No tool named/);
    } finally {
      setActiveMCPManager(null);
    }
  });
});
