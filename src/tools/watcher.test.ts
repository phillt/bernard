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
