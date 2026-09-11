import { describe, it, expect, vi } from 'vitest';

import { probe, watchableToolRefusal, type ProbeDeps } from './probe.js';
import { attachMeta } from '../framework/tools/adapter.js';
import type { ToolMeta } from '../framework/tools/types.js';

/**
 * Every dependency is injected, so none of this needs a network, an MCP server
 * or a built `dist/` — the `voice-service.ts` idiom.
 */
function deps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    fetch: vi.fn(async () => new Response('body', { status: 200 })) as unknown as typeof fetch,
    statFile: () => null,
    tools: () => ({}),
    ...over,
  };
}

function fakeTool(meta: Partial<ToolMeta>, execute: (a: unknown) => Promise<unknown>) {
  return attachMeta(
    { description: '', parameters: {} as never, execute } as never,
    {
      name: 'x',
      kind: 'read',
      deterministic: false,
      sideEffect: 'network',
      ...meta,
    } as ToolMeta,
  );
}

describe('watchableToolRefusal', () => {
  it('allows a read-classified tool', () => {
    expect(
      watchableToolRefusal(
        'gmail_list',
        fakeTool({ kind: 'read' }, async () => ({})),
      ),
    ).toBeNull();
  });

  it('refuses a write tool', () => {
    // A watcher runs unattended and repeatedly. A write target would be a way to
    // make something happen 1,440 times a day with nobody looking.
    const r = watchableToolRefusal(
      'gmail_send',
      fakeTool({ kind: 'write' }, async () => ({})),
    );
    expect(r).toMatch(/not a read-only tool/);
  });

  it('refuses a tool that does not exist, and says so', () => {
    expect(watchableToolRefusal('nope', undefined)).toMatch(/No tool named/);
  });

  it('accepts an MCP read suffix even when meta is absent', () => {
    // `mcp.ts` classifies the `*_list` / `*_search` / `*_get` family as read;
    // this is the same fact stated by the name, for a tool that carries no meta.
    const bare = { execute: async () => ({}) };
    expect(watchableToolRefusal('srv_ab12__messages_search', bare)).toBeNull();
    expect(watchableToolRefusal('srv_ab12__messages_send', bare)).toMatch(/not a read-only/);
  });
});

describe('probe — http', () => {
  it('sends conditional headers and trusts a 304', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 304 }));
    const d = deps({ fetch: fetchMock as unknown as typeof fetch });
    const r = await probe({ kind: 'http', url: 'https://e.com' }, d, {
      etag: 'W/"v1"',
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    });

    expect(r).toEqual({ ok: true, observation: { value: null, unchanged: true } });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['if-none-match']).toBe('W/"v1"');
    expect(headers['if-modified-since']).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
  });

  it('carries validators forward from a 200', async () => {
    const res = new Response('hello', { status: 200, headers: { etag: 'W/"v2"' } });
    const r = await probe(
      { kind: 'http', url: 'https://e.com' },
      deps({
        fetch: (async () => res) as unknown as typeof fetch,
      }),
    );
    expect(r).toMatchObject({ ok: true, observation: { value: 'hello', etag: 'W/"v2"' } });
  });

  it('reports a non-2xx as a failure, not as content', async () => {
    const r = await probe(
      { kind: 'http', url: 'https://e.com' },
      deps({
        fetch: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
      }),
    );
    expect(r).toEqual({ ok: false, error: 'HTTP 500' });
  });
});

describe('probe — file', () => {
  it('reports absence as an observation, not a failure', async () => {
    // "Tell me when this file appears" is a real thing to want. Reported as a
    // failure it would tick the failure counter until the watcher gave up
    // waiting for the very thing it was watching for.
    const r = await probe({ kind: 'file', path: '/nope' }, deps({ statFile: () => null }));
    expect(r).toEqual({ ok: true, observation: { value: { exists: false } } });
  });

  it('reports mtime and size', async () => {
    const r = await probe(
      { kind: 'file', path: '/x' },
      deps({
        statFile: () => ({ mtimeMs: 42, size: 7 }),
      }),
    );
    expect(r).toMatchObject({ observation: { value: { exists: true, mtimeMs: 42, size: 7 } } });
  });
});

describe('probe — mcp', () => {
  it('unwraps a single-text CallToolResult so a $. path means what it says', async () => {
    // Without this every watcher path would have to start `$.content[0].text`
    // and then could not traverse into it at all — the payload is JSON encoded
    // as a string inside the envelope.
    const tool = fakeTool({ kind: 'read' }, async () => ({
      content: [{ type: 'text', text: JSON.stringify({ messages: [{ id: 'm1' }] }) }],
    }));
    const r = await probe(
      { kind: 'mcp', tool: 't', args: {} },
      deps({ tools: () => ({ t: tool }) }),
    );
    expect(r).toMatchObject({ ok: true, observation: { value: { messages: [{ id: 'm1' }] } } });
  });

  it('leaves prose alone', async () => {
    const tool = fakeTool({ kind: 'read' }, async () => ({
      content: [{ type: 'text', text: 'not json' }],
    }));
    const r = await probe(
      { kind: 'mcp', tool: 't', args: {} },
      deps({ tools: () => ({ t: tool }) }),
    );
    expect(r).toMatchObject({ observation: { value: 'not json' } });
  });

  it('refuses a write tool before calling it', async () => {
    const execute = vi.fn(async () => ({}));
    const tool = fakeTool({ kind: 'write' }, execute);
    const r = await probe(
      { kind: 'mcp', tool: 't', args: {} },
      deps({ tools: () => ({ t: tool }) }),
    );
    expect(r).toMatchObject({ ok: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it('turns a throwing tool into a counted failure, never a throw', async () => {
    const tool = fakeTool({ kind: 'read' }, async () => {
      throw new Error('server down');
    });
    const r = await probe(
      { kind: 'mcp', tool: 't', args: {} },
      deps({ tools: () => ({ t: tool }) }),
    );
    expect(r).toEqual({ ok: false, error: 'server down' });
  });

  it('re-reads the registry on every probe', async () => {
    // Caching the flat tool bag is exactly the #305 regression `snapshot()`'s
    // docstring exists to prevent, so the poller passes a getter, not a value.
    const tools = vi.fn(() => ({ t: fakeTool({ kind: 'read' }, async () => ({ ok: 1 })) }));
    const d = deps({ tools });
    await probe({ kind: 'mcp', tool: 't', args: {} }, d);
    await probe({ kind: 'mcp', tool: 't', args: {} }, d);
    expect(tools).toHaveBeenCalledTimes(2);
  });
});

describe('probe — time', () => {
  it('makes no call at all', async () => {
    const fetchMock = vi.fn();
    const r = await probe(
      { kind: 'time', at: new Date().toISOString() },
      deps({
        fetch: fetchMock as unknown as typeof fetch,
      }),
    );
    expect(r).toEqual({ ok: true, observation: { value: null } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
