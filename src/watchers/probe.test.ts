import { describe, it, expect, vi } from 'vitest';

import { captureBaseline, probe, watchableToolRefusal, type ProbeDeps } from './probe.js';
import { attachMeta } from '../framework/tools/adapter.js';
import type { ToolMeta } from '../framework/tools/types.js';
import { MAX_PROBE_RESULT_CHARS } from './types.js';

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

/**
 * The dead `idPath` (found in use, on Beeper).
 *
 * Beeper returns `{items:[{id,…}]}`; the tool's example said `$.messages.id`,
 * and a reasonable guess of `$.id` produced three watchers that polled cleanly
 * every 60s for an hour, kept `failureCount: 0`, and could never fire. A
 * watcher that cannot read its own predicate is the exact silent failure this
 * feature exists to remove.
 */
describe('captureBaseline — a predicate that can never match', () => {
  const beeper = (value: unknown) =>
    deps({
      tools: () => ({
        t: fakeTool({ kind: 'read' }, async () => ({
          content: [{ type: 'text', text: JSON.stringify(value) }],
        })),
      }),
    });

  it('refuses an idPath that names no list, instead of defaulting to empty', async () => {
    const got = await captureBaseline(
      { kind: 'mcp', tool: 't', args: {} },
      { kind: 'appeared', idPath: '$.id' },
      beeper({ items: [{ id: '1073', text: 'hi' }], hasMore: true }),
    );
    expect(got.ok).toBe(false);
    expect((got as { error: string }).error).toMatch(/does not name a list/);
  });

  it('names a path that would actually work', async () => {
    // The half that makes it self-correcting: a model that guessed wrong can
    // fix itself rather than retrying the same guess.
    const got = await captureBaseline(
      { kind: 'mcp', tool: 't', args: {} },
      { kind: 'appeared', idPath: '$.id' },
      beeper({ items: [{ id: '1073' }], hasMore: true }),
    );
    expect((got as { error: string }).error).toMatch(/\$\.items\.id/);
  });

  it('accepts the correct path against the real Beeper shape', async () => {
    const got = await captureBaseline(
      { kind: 'mcp', tool: 't', args: {} },
      { kind: 'appeared', idPath: '$.items.id' },
      beeper({ items: [{ id: '1073' }, { id: '1072' }], hasMore: true }),
    );
    expect(got).toMatchObject({ ok: true, baselineIds: ['1073', '1072'] });
  });

  it('says so plainly when nothing in the payload could serve', async () => {
    const got = await captureBaseline(
      { kind: 'mcp', tool: 't', args: {} },
      { kind: 'appeared', idPath: '$.items.id' },
      beeper({ count: 3, ok: true }),
    );
    expect((got as { error: string }).error).toMatch(/no array of objects with an id/);
  });
});

/**
 * The probe's own ceiling (#572).
 *
 * `probeHttp` has bounded its body since it was written; `probeMcp` had
 * nothing, and `unwrap` runs `JSON.parse` on arbitrary server text — the one
 * place this module amplifies a string into an object graph.
 */
describe('probe — the MCP result ceiling', () => {
  const returning = (result: unknown) =>
    deps({ tools: () => ({ t: fakeTool({ kind: 'read' }, async () => result) }) });

  const textResult = (text: string) => ({ content: [{ type: 'text', text }] });

  /** A payload whose TEXT is `chars` long and which parses to a real list. */
  function pageOf(chars: number): { content: { type: string; text: string }[] } {
    const filler = 'x'.repeat(Math.max(1, chars - 40));
    return textResult(JSON.stringify({ items: [{ id: 'a', text: filler }] }));
  }

  it('accepts a payload at the ceiling', async () => {
    const at = pageOf(MAX_PROBE_RESULT_CHARS);
    expect(at.content[0].text.length).toBeLessThanOrEqual(MAX_PROBE_RESULT_CHARS);
    const got = await probe({ kind: 'mcp', tool: 't', args: {} }, returning(at));
    expect(got.ok).toBe(true);
  });

  it('refuses past it, naming the size and the remedy', async () => {
    const got = await probe(
      { kind: 'mcp', tool: 't', args: {} },
      returning(pageOf(MAX_PROBE_RESULT_CHARS + 5_000)),
    );
    expect(got.ok).toBe(false);
    const err = (got as { error: string }).error;
    expect(err).toMatch(String(MAX_PROBE_RESULT_CHARS));
    // Actionable, because the caller is a model that will otherwise recreate
    // the same watcher against the same tool.
    expect(err).toMatch(/limit or page-size/);
  });

  it('refuses BEFORE parsing, not after', async () => {
    // The payload is oversized AND not valid JSON. `unwrap`'s catch treats
    // unparseable text as prose and returns `ok: true`, so a refusal here is
    // proof the early return fired and `JSON.parse` never ran on 1 MB.
    const got = await probe(
      { kind: 'mcp', tool: 't', args: {} },
      returning(textResult('not json '.repeat(MAX_PROBE_RESULT_CHARS / 4))),
    );
    expect(got.ok).toBe(false);
  });

  it('leaves the shapes it cannot measure cheaply alone', async () => {
    // Deliberate non-goal, pinned so nobody "completes" the bound with a
    // `stableStringify` size check — which would pay the whole cost this
    // exists to avoid, on every poll, to discover a number.
    //
    // A multi-entry `content` and an already-structured result both arrive
    // parsed by the MCP client, so their memory is spent before this module
    // sees them and there is nothing left to refuse.
    const big = 'x'.repeat(MAX_PROBE_RESULT_CHARS + 5_000);
    const multi = await probe(
      { kind: 'mcp', tool: 't', args: {} },
      returning({
        content: [
          { type: 'text', text: big },
          { type: 'text', text: 'b' },
        ],
      }),
    );
    expect(multi.ok).toBe(true);

    const structured = await probe(
      { kind: 'mcp', tool: 't', args: {} },
      returning({ items: [{ id: 'a', text: big }] }),
    );
    expect(structured.ok).toBe(true);
  });

  it('refuses at CREATION too, where the model can still act on it', async () => {
    // `captureBaseline` runs the same `probe`, so the ceiling reaches the
    // authoring model immediately rather than surfacing an hour later as a
    // watcher that stopped after `MAX_PROBE_FAILURES`.
    const got = await captureBaseline(
      { kind: 'mcp', tool: 't', args: {} },
      { kind: 'appeared', idPath: '$.items.id' },
      returning(pageOf(MAX_PROBE_RESULT_CHARS + 5_000)),
    );
    expect(got.ok).toBe(false);
    expect((got as { error: string }).error).toMatch(/limit or page-size/);
  });
});
