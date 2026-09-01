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
  // Delegation runs uncapped (#305): it must not be starved even when its
  // caller holds no slot. The mock just runs the body.
  withUncappedSlot: vi.fn((fn: (slot: { id: number }) => Promise<unknown>) => fn({ id: 1 })),
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
import { withUncappedSlot } from './agent-pool.js';
import { detectResultFailure } from '../tool-result-shape.js';
import { flattenServerTools } from '../mcp-names.js';

const SERVER_TOOLS: Record<string, Record<string, any>> = {
  google: { google__list: { g: 1 }, google__get: { g: 2 } },
  slack: { slack__post: { s: 1 } },
};

function makeCtx(over: Record<string, any> = {}): any {
  return {
    config: { mcpDelegation: true, mcpDelegateEscalation: true },
    toolOptions: { askUser: vi.fn() },
    policyDecision: { toolMode: { mode: 'read-only' } },
    mcp: {
      // Derived exactly as `MCPManager.snapshot()` does, so the fixture cannot
      // encode a flat bag and a per-server map that disagree (#413).
      tools: flattenServerTools(SERVER_TOOLS),
      serverNames: ['google', 'slack'],
      serverTools: SERVER_TOOLS,
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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

  it('returns the capped formatted summary, uncapped by the pool (#305)', async () => {
    // Uncapped because the main agent holds no slot of its own: routing its
    // `delegate_*` calls through the capped path would let parallel sub-agents
    // starve main's MCP access. The cap behaviour itself is covered unmocked in
    // `agent-pool.test.ts`.
    const out = await dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x' });
    expect(out).toBe('SUMMARY');
    expect(withUncappedSlot).toHaveBeenCalledTimes(1);
  });

  it('catches a dispatch throw and returns a DETECTABLE error string (#364)', async () => {
    // With delegation on, `delegate_<server>` is the main agent's MCP surface,
    // so an undetectable failure here registers as citable evidence and bumps
    // successCount — observed at 36 successes / 0 errors. This site had no
    // coverage of the failure *shape* at all, which is how it drifted.
    vi.mocked(runDefinition).mockRejectedValueOnce(new Error('boom'));
    const out = await dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x' });
    expect(out).toContain('boom');
    expect(out).toContain('Delegation to "google" failed');
    expect(detectResultFailure(out)).toBeDefined();
  });

  it('re-throws a cancellation rather than returning it as a summary (#327)', async () => {
    // A returned string is a *successful* tool result. Right for a failed MCP
    // call the model can react to; wrong for "the dispatch was cancelled",
    // which the parent then reads as data and loops on.
    vi.mocked(runDefinition).mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    await expect(
      dispatchServerDelegate(makeCtx(), { server: 'google', task: 'x' }),
    ).rejects.toMatchObject({ name: 'AbortError' });
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
    expect(withUncappedSlot).toHaveBeenCalledTimes(1);
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

/**
 * #332 guard.
 *
 * The issue proposed prebuilding the per-server delegate bag once and hanging
 * it off `AgentContextMCP`, so `tool-surface.ts` would stop importing the tool
 * layer. It cannot be done that way, and this test is the reason.
 *
 * A delegate tool closes over the `AgentContext` it was built from, and
 * `Agent.processInput` RE-POINTS `this.ctx` every turn
 * (`this.ctx = { ...this.ctx, policyDecision }`, `agent.ts`). So a bag built
 * once at session start would capture a context whose `policyDecision` is
 * permanently `undefined` — and `dispatchServerDelegate` forwards that context
 * straight to `runDefinition`, where `policyDecision.toolMode` drives the
 * read-only block gate (#179) and the confirm gate (#144). Caching the bag
 * would silently disable both on every delegated MCP call.
 *
 * Rebuilding per dispatch (what `runDefinition` does today) is what keeps the
 * binding live. If someone reintroduces caching, this fails.
 */
describe('delegate tools bind to the live context (#332)', () => {
  it('forwards the policyDecision of the context the tool was built from', async () => {
    const ctx = makeCtx({ policyDecision: { toolMode: { mode: 'read-only' } } });
    const tools: any = createDelegateTools(ctx);

    await tools.delegate_google.execute({ task: 'x' }, {});

    const forwarded = vi.mocked(runDefinition).mock.calls[0][0] as any;
    expect(forwarded.policyDecision).toEqual({ toolMode: { mode: 'read-only' } });
  });

  it('is not memoized — a re-pointed context yields tools bound to the new one', async () => {
    // `Agent.processInput` does exactly this at the top of every turn, so the
    // second context is a DIFFERENT object with the same `mcp`. Any cache keyed
    // on the session, or on `ctx.mcp` (which is never re-assigned and so looks
    // like a stable key), would hand back the first context's tools and fail
    // the policyDecision assertion below.
    const turn1 = makeCtx({ policyDecision: { toolMode: { mode: 'read-only' } } });
    const turn2 = { ...turn1, policyDecision: { toolMode: { mode: 'write' } } };

    const tools1: any = createDelegateTools(turn1);
    const tools2: any = createDelegateTools(turn2);
    expect(tools2.delegate_google).not.toBe(tools1.delegate_google);

    await tools2.delegate_google.execute({ task: 'x' }, {});

    const forwarded = vi.mocked(runDefinition).mock.calls[0][0] as any;
    expect(forwarded).toBe(turn2);
    expect(forwarded.policyDecision).toEqual({ toolMode: { mode: 'write' } });
  });
});
