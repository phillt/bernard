import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (before imports that pull them in) ──────────────────────────

vi.mock('ai', () => ({
  tool: vi.fn((def: any) => def),
}));

vi.mock('../framework/tools/adapter.js', () => ({
  attachMeta: vi.fn((t: any, meta: any) => Object.assign(t, { meta })),
}));

vi.mock('../framework/agents/run.js', () => ({
  runDefinition: vi.fn(async () => ({
    result: {},
    formatted: 'SUMMARY',
    resolved: {},
    stepLimitHit: false,
  })),
}));

vi.mock('../framework/pac/run-pac.js', () => ({
  runPAC: vi.fn(async () => ({
    formatted: 'PAC_SUMMARY',
    verdict: 'pass',
    reason: 'ok',
    retries: 0,
  })),
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

import { createDelegateTool, createDelegateTools, sanitizeServerToolName } from './delegate.js';
import { dispatchServerDelegate } from './delegate-dispatch.js';
import { buildDelegateSystemPrompt } from '../framework/agents/mcp-delegate.js';
import { runDefinition } from '../framework/agents/run.js';
import { runPAC } from '../framework/pac/run-pac.js';
import { acquireSlot, releaseSlot } from './agent-pool.js';

function makeCtx(over: Record<string, any> = {}): any {
  return {
    config: { mcpDelegation: true, mcpDelegateEscalation: true },
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
    stepLimitHit: false,
  } as any);
  vi.mocked(runPAC).mockResolvedValue({
    formatted: 'PAC_SUMMARY',
    verdict: 'pass',
    reason: 'ok',
    retries: 0,
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

  it('acquires its slot as nested, so a full pool cannot starve it (#305)', async () => {
    // Replaces a test that mocked `acquireSlot` to null and asserted a
    // pool-exhausted message. That state is now unreachable: this helper runs
    // inside a dispatch that already holds a slot, and sub-agents carry
    // `delegate_*` tools — competing for the flat cap would silently strip MCP
    // from every sub-agent the moment fan-out filled the pool. The invariant
    // worth pinning is the `nested` flag, not the dead branch.
    await dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x' });
    expect(acquireSlot).toHaveBeenCalledWith({ nested: true });
  });

  it('catches a dispatch throw, releases the slot, and returns an error string', async () => {
    vi.mocked(runDefinition).mockRejectedValueOnce(new Error('boom'));
    const out = await dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x' });
    expect(out).toContain('boom');
    expect(releaseSlot).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchServerDelegate self-escalation (#296 Phase 2E)', () => {
  function stepLimited() {
    vi.mocked(runDefinition).mockResolvedValue({
      result: {},
      formatted: 'PARTIAL',
      resolved: {},
      stepLimitHit: true,
    } as any);
  }

  it('does NOT escalate when the single loop finished cleanly (stepLimitHit false)', async () => {
    const out = await dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x' });
    expect(runPAC).not.toHaveBeenCalled();
    expect(out).toBe('SUMMARY');
  });

  it('escalates once to runPAC when the single loop hit its step limit', async () => {
    stepLimited();
    const out = await dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x' });
    expect(runPAC).toHaveBeenCalledTimes(1);
    expect(out).toBe('PAC_SUMMARY');
  });

  it("scopes the escalated PAC actor to the server's childTools (no full MCP bag leak)", async () => {
    stepLimited();
    await dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x' });
    const pacInput = vi.mocked(runPAC).mock.calls[0][1] as any;
    expect(Object.keys(pacInput.childTools).sort()).toEqual([
      'ask_user',
      'google__get',
      'google__list',
    ]);
    expect(pacInput.childTools.slack__post).toBeUndefined();
  });

  it('attributes escalated PAC spend to the same mcp:<server> site and reuses the slot', async () => {
    stepLimited();
    await dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x' });
    const pacInput = vi.mocked(runPAC).mock.calls[0][1] as any;
    const pacOpts = vi.mocked(runPAC).mock.calls[0][2] as any;
    expect(pacOpts.telemetrySite).toBe('mcp:google');
    expect(pacInput.slotId).toBe(1);
    // Same slot reused for the escalation — no second acquire.
    expect(acquireSlot).toHaveBeenCalledTimes(1);
    expect(releaseSlot).toHaveBeenCalledTimes(1);
  });

  it("threads the single loop's partial findings into the PAC context (continue, not restart)", async () => {
    stepLimited();
    await dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x', context: 'orig' });
    const pacInput = vi.mocked(runPAC).mock.calls[0][1] as any;
    expect(pacInput.context).toContain('orig');
    expect(pacInput.context).toContain('PARTIAL');
    expect(pacInput.context).toContain('step limit');
  });

  it('does NOT escalate when mcpDelegateEscalation is disabled', async () => {
    stepLimited();
    const ctx = makeCtx();
    ctx.config.mcpDelegateEscalation = false;
    const out = await dispatchServerDelegate(ctx, { server: 'google', task: 'x' });
    expect(runPAC).not.toHaveBeenCalled();
    expect(out).toBe('PARTIAL');
  });
});
