import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (before imports that pull them in) ──────────────────────────

vi.mock('ai', () => ({
  tool: vi.fn((def: any) => def),
}));

vi.mock('../framework/tools/adapter.js', () => ({
  attachMeta: vi.fn((t: any, meta: any) => Object.assign(t, { meta })),
}));

vi.mock('../framework/agents/run.js', () => ({
  runDefinition: vi.fn(async () => ({ result: {}, formatted: 'SUMMARY', resolved: {} })),
}));

vi.mock('./agent-pool.js', () => ({
  acquireSlot: vi.fn(() => ({ id: 1 })),
  releaseSlot: vi.fn(),
  getMaxConcurrentAgents: vi.fn(() => 4),
}));

vi.mock('./ask-user.js', () => ({
  createAskUserTool: vi.fn(() => ({ __askUser: true })),
}));

vi.mock('../logger.js', () => ({
  debugLog: vi.fn(),
}));

import {
  createDelegateTool,
  createDelegateTools,
  dispatchServerDelegate,
  sanitizeServerToolName,
} from './delegate.js';
import { buildDelegateSystemPrompt } from '../framework/agents/mcp-delegate.js';
import { runDefinition } from '../framework/agents/run.js';
import { acquireSlot, releaseSlot } from './agent-pool.js';

function makeCtx(over: Record<string, any> = {}): any {
  return {
    config: { mcpDelegation: true },
    toolOptions: { askUser: vi.fn() },
    policyDecision: { toolMode: { mode: 'read-only' } },
    mcp: {
      tools: {
        google__list: { g: 1 },
        google__get: { g: 2 },
        slack__post: { s: 1 },
      },
      serverNames: ['google', 'slack'],
      serverTools: {
        google: ['google__list', 'google__get'],
        slack: ['slack__post'],
      },
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(acquireSlot).mockReturnValue({ id: 1 });
  vi.mocked(runDefinition).mockResolvedValue({
    result: {},
    formatted: 'SUMMARY',
    resolved: {},
  } as any);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('sanitizeServerToolName', () => {
  it('keeps valid tool-name characters intact', () => {
    expect(sanitizeServerToolName('google')).toBe('google');
    expect(sanitizeServerToolName('google-calendar')).toBe('google-calendar');
    expect(sanitizeServerToolName('my_server')).toBe('my_server');
  });

  it('replaces invalid characters with underscores', () => {
    expect(sanitizeServerToolName('my server!')).toBe('my_server_');
    expect(sanitizeServerToolName('a.b/c')).toBe('a_b_c');
  });
});

describe('buildDelegateSystemPrompt', () => {
  it('names the server, lists tools, and forbids raw dumps', () => {
    const p = buildDelegateSystemPrompt('google', ['google__list', 'google__get']);
    expect(p).toContain('"google"');
    expect(p).toContain('google__list, google__get');
    expect(p).toContain('NEVER dump raw');
    expect(p).toContain('ask_user');
  });

  it('handles a server with no registered tools gracefully', () => {
    const p = buildDelegateSystemPrompt('empty', []);
    expect(p).toContain('none currently registered');
  });
});

describe('createDelegateTools', () => {
  it('creates one delegate tool per connected server that has tools', () => {
    const tools = createDelegateTools(makeCtx());
    expect(Object.keys(tools).sort()).toEqual(['delegate_google', 'delegate_slack']);
  });

  it('skips servers with no tools', () => {
    const ctx = makeCtx();
    ctx.mcp.serverNames = ['google', 'slack', 'ghost'];
    ctx.mcp.serverTools.ghost = [];
    const tools = createDelegateTools(ctx);
    expect(Object.keys(tools)).not.toContain('delegate_ghost');
  });

  it('disambiguates delegate-name collisions with a numeric suffix', () => {
    const ctx = makeCtx();
    // Two distinct server names that sanitize to the same token.
    ctx.mcp.serverNames = ['a.b', 'a/b'];
    ctx.mcp.serverTools = { 'a.b': ['a.b__x'], 'a/b': ['a/b__y'] };
    ctx.mcp.tools = { 'a.b__x': {}, 'a/b__y': {} };
    const tools = createDelegateTools(ctx);
    expect(Object.keys(tools).sort()).toEqual(['delegate_a_b', 'delegate_a_b_2']);
  });
});

describe('createDelegateTool', () => {
  it('names the tool delegate_<sanitized-server> and describes the server', () => {
    const t: any = createDelegateTool(makeCtx(), 'google');
    expect(t.meta.name).toBe('delegate_google');
    expect(t.meta.kind).toBe('read');
    expect(t.description).toContain('google');
  });
});

describe('dispatchServerDelegate', () => {
  it('forwards the parent ctx (toolOptions + policyDecision) straight to runDefinition', async () => {
    const ctx = makeCtx();
    await dispatchServerDelegate(ctx, { server: 'google', task: 'find the latest email' });

    expect(runDefinition).toHaveBeenCalledTimes(1);
    const [ctxArg] = vi.mocked(runDefinition).mock.calls[0];
    // Identity: the SAME context object is passed, so policyDecision (#179
    // block gate) and toolOptions (confirm gate + askUser) are guaranteed
    // forwarded — no fresh context that could drop them.
    expect(ctxArg).toBe(ctx);
    expect((ctxArg as any).policyDecision).toBe(ctx.policyDecision);
  });

  it('attributes the helper spend to the mcp:<server> telemetry site', async () => {
    await dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x' });
    const opts = vi.mocked(runDefinition).mock.calls[0][3] as any;
    expect(opts.telemetrySite).toBe('mcp:google');
  });

  it("scopes childTools to just that server's tools plus ask_user", async () => {
    await dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x' });
    const input = vi.mocked(runDefinition).mock.calls[0][2] as any;
    expect(Object.keys(input.childTools).sort()).toEqual([
      'ask_user',
      'google__get',
      'google__list',
    ]);
    // A different server's tools never leak into the helper's registry.
    expect(input.childTools.slack__post).toBeUndefined();
  });

  it('returns the capped formatted summary and releases the pool slot', async () => {
    const out = await dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x' });
    expect(out).toBe('SUMMARY');
    expect(releaseSlot).toHaveBeenCalledTimes(1);
  });

  it('returns a friendly message and never dispatches when the pool is exhausted', async () => {
    vi.mocked(acquireSlot).mockReturnValue(null);
    const out = await dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x' });
    expect(out).toContain('maximum concurrent agents');
    expect(runDefinition).not.toHaveBeenCalled();
    expect(releaseSlot).not.toHaveBeenCalled();
  });

  it('catches a dispatch throw, releases the slot, and returns an error string', async () => {
    vi.mocked(runDefinition).mockRejectedValueOnce(new Error('boom'));
    const out = await dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x' });
    expect(out).toContain('boom');
    expect(releaseSlot).toHaveBeenCalledTimes(1);
  });
});
