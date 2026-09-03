import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks ---

const mockMcpManager = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  snapshot: vi.fn().mockReturnValue({
    tools: {},
    serverNames: ['alpha', 'beta'],
    serverTools: {},
    resolveAlias: () => null,
  }),
  close: vi.fn().mockResolvedValue(undefined),
}));

const mockRagSearch = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockRagStoreCtor = vi.hoisted(() => vi.fn(() => ({ search: mockRagSearch })));

const mockRunDefinition = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ formatted: 'done', stepLimitHit: false }),
);

const mockRegisterBuiltins = vi.hoisted(() => vi.fn());
const mockAssembleContext = vi.hoisted(() =>
  vi.fn((input: any) => ({
    config: input.config,
    stores: input.stores ?? {},
    mcp: input.mcp,
    rag: input.rag,
    toolOptions: input.toolOptions,
    provenance: {},
    verification: { getLast: () => undefined },
    verificationTracker: {},
    postWriteChecks: [],
  })),
);

vi.mock('./mcp.js', () => ({ MCPManager: vi.fn(() => mockMcpManager) }));
vi.mock('./rag.js', () => ({ RAGStore: mockRagStoreCtor }));
vi.mock('./framework/agents/run.js', () => ({ runDefinition: mockRunDefinition }));
vi.mock('./framework/agents/index.js', () => ({
  registerBuiltinDefinitions: mockRegisterBuiltins,
}));
vi.mock('./framework/context.js', () => ({ assembleContext: mockAssembleContext }));
vi.mock('./permissions/shell-ast.js', () => ({ initShellParser: vi.fn() }));
vi.mock('./logger.js', () => ({ debugLog: vi.fn(), isDebugEnabled: () => false }));

vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    loadConfig: vi.fn().mockReturnValue({
      provider: 'anthropic',
      model: 'test',
      maxTokens: 1024,
      shellTimeout: 5000,
      tokenWindow: 0,
      ragEnabled: true,
    }),
  };
});

import { runHeadless, resolvePosture, type RunHeadlessOpts } from './headless.js';

const fakeDefinition = { id: 'fake' } as any;

function opts(over: Partial<RunHeadlessOpts<any, string>> = {}): RunHeadlessOpts<any, string> {
  return {
    definition: () => fakeDefinition,
    buildInput: () => ({}),
    posture: resolvePosture({
      toolMode: 'write',
      confirmMode: 'auto',
      writeScope: null,
      toolPermissions: null,
    }),
    timeoutMs: null,
    log: () => {},
    debugLabel: 'test',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMcpManager.connect.mockResolvedValue(undefined);
  mockMcpManager.snapshot.mockReturnValue({
    tools: {},
    serverNames: ['alpha', 'beta'],
    serverTools: {},
    resolveAlias: () => null,
  });
  mockRagSearch.mockResolvedValue([]);
  mockRunDefinition.mockResolvedValue({ formatted: 'done', stepLimitHit: false });
  mockRagStoreCtor.mockImplementation(() => ({ search: mockRagSearch }) as any);
});

describe('resolvePosture', () => {
  it('maps confirmMode onto the canonical threshold', () => {
    expect(
      resolvePosture({
        toolMode: 'write',
        confirmMode: 'auto',
        writeScope: null,
        toolPermissions: null,
      }).confirmThreshold,
    ).toBe('high');
    expect(
      resolvePosture({
        toolMode: 'write',
        confirmMode: 'strict',
        writeScope: null,
        toolPermissions: null,
      }).confirmThreshold,
    ).toBe('medium');
    expect(
      resolvePosture({
        toolMode: 'write',
        confirmMode: 'off',
        writeScope: null,
        toolPermissions: null,
      }).confirmThreshold,
    ).toBe('never');
  });

  it('collapses to write + off under skipPermissions, overriding both axes', () => {
    const p = resolvePosture({
      toolMode: 'read-only',
      confirmMode: 'strict',
      skipPermissions: true,
    });
    expect(p.toolMode).toBe('write');
    expect(p.confirmMode).toBe('off');
    expect(p.confirmThreshold).toBe('never');
  });

  it('keeps the two axes orthogonal — confirmMode:off does not unblock read-only', () => {
    const p = resolvePosture({
      toolMode: 'read-only',
      confirmMode: 'off',
      writeScope: null,
      toolPermissions: null,
    });
    expect(p.toolMode).toBe('read-only');
    expect(p.confirmThreshold).toBe('never');
  });

  // `skipPermissions` is the documented "no safeguards" contract, and it has
  // to dissolve ALL gates. Leaving the scope in place made a job the user
  // explicitly marked unrestricted still refuse `file_write` outside its
  // workspace — while `shell` in that same job stayed wide open, because shell
  // DOES dissolve. That pushes the model toward the less safe tool.
  it('dissolves the write scope under skipPermissions, like the other axes', () => {
    const scope = { workspace: '/tmp/ws' };
    expect(
      resolvePosture({
        toolMode: 'write',
        confirmMode: 'auto',
        writeScope: scope,
        toolPermissions: null,
      }).writeScope,
    ).toBe(scope);
    expect(
      resolvePosture({
        toolMode: 'write',
        confirmMode: 'auto',
        writeScope: scope,
        toolPermissions: null,
        skipPermissions: true,
      }).writeScope,
    ).toBeNull();
  });

  it('auto-denies a high-risk call and passes a low-risk one under the default posture', async () => {
    const { confirmAction } = resolvePosture({
      toolMode: 'write',
      confirmMode: 'auto',
      writeScope: null,
      toolPermissions: null,
    });
    await expect(confirmAction({ risk: 'high' } as any)).resolves.toBe(false);
    await expect(confirmAction({ risk: 'low' } as any)).resolves.toBe(true);
  });
});

describe('runHeadless', () => {
  it('registers builtin definitions before resolving the definition', async () => {
    const order: string[] = [];
    mockRegisterBuiltins.mockImplementation(() => order.push('register'));
    await runHeadless(
      opts({
        definition: () => {
          order.push('resolve');
          return fakeDefinition;
        },
      }),
    );
    expect(order).toEqual(['register', 'resolve']);
  });

  it('hands buildInput the connected server names and the RAG results', async () => {
    mockRagSearch.mockResolvedValue([{ id: 'f1', text: 'fact' }]);
    const buildInput = vi.fn().mockReturnValue({});
    await runHeadless(opts({ buildInput, ragQuery: 'why' }));

    const env = buildInput.mock.calls[0][0];
    expect(env.mcp.serverNames).toEqual(['alpha', 'beta']);
    expect(env.ragResults).toEqual([{ id: 'f1', text: 'fact' }]);
    expect(env.runId).toEqual(expect.any(String));
  });

  // Not merely "does not search": the RAGStore constructor reads and parses the
  // whole embedding file (~190 ms / ~128 MB on a real store) and then stays
  // resident via the returned env. A caller that never retrieves must not pay it.
  it('never even constructs the RAG store when no ragQuery is given', async () => {
    await runHeadless(opts());
    expect(mockRagSearch).not.toHaveBeenCalled();
    expect(mockRagStoreCtor).not.toHaveBeenCalled();
  });

  it('uses a caller-supplied runId so its debug lines join the caller records', async () => {
    const buildInput = vi.fn().mockReturnValue({});
    const res = await runHeadless(opts({ buildInput, runId: 'caller-minted' }));
    expect(buildInput.mock.calls[0][0].runId).toBe('caller-minted');
    expect(res.env.runId).toBe('caller-minted');
  });

  it('is fail-soft when the RAG search throws', async () => {
    mockRagSearch.mockRejectedValue(new Error('embedding backend down'));
    const res = await runHeadless(opts({ ragQuery: 'why' }));
    expect(res.ok).toBe(true);
  });

  it('continues without MCP tools when connect fails', async () => {
    mockMcpManager.connect.mockRejectedValue(new Error('no servers'));
    const buildInput = vi.fn().mockReturnValue({});
    const res = await runHeadless(opts({ buildInput }));
    expect(res.ok).toBe(true);
    expect(buildInput.mock.calls[0][0].mcp.serverNames).toEqual([]);
  });

  // The fail-closed toolOptions shape is the reason a headless entry point is
  // safe at all. Omission is the mechanism — `augmentTools` auto-denies when
  // `blockAction` is absent — so a test that only checked `confirmAction` would
  // pass while the gates silently opened.
  it('omits blockAction, askUser, getToolPermissions and sessionToolAllowlist', async () => {
    await runHeadless(opts());
    const { toolOptions } = mockAssembleContext.mock.calls[0][0];
    expect(toolOptions.confirmAction).toBeTypeOf('function');
    expect(toolOptions.confirmDangerous).toBeTypeOf('function');
    expect(toolOptions).not.toHaveProperty('blockAction');
    expect(toolOptions).not.toHaveProperty('askUser');
    expect(toolOptions).not.toHaveProperty('getToolPermissions');
    expect(toolOptions).not.toHaveProperty('sessionToolAllowlist');
  });

  // `getToolPermissions` stops being absent only when the caller resolved
  // rules — cron passes `null` and keeps the shape above. A LIVE reader, not
  // a captured array, so editing a grant changes the next invocation with no
  // restart: #420's revocation requirement falls out of the shape.
  it('supplies a live getToolPermissions reader when rules were resolved', async () => {
    const rules = [{ effect: 'deny' as const, tool: 'web_read', _v: 2 as const }];
    await runHeadless(
      opts({
        posture: resolvePosture({
          toolMode: 'read-only',
          confirmMode: 'auto',
          writeScope: null,
          toolPermissions: rules,
        }),
      }),
    );
    const { toolOptions } = mockAssembleContext.mock.calls[0][0];
    expect(toolOptions.getToolPermissions()).toEqual(rules);
  });

  // `skipPermissions` dissolves every gate. Leaving the rules in place would
  // make a run the caller marked unrestricted still refuse a denied tool —
  // the same steer-toward-the-ungated-tool asymmetry the write scope had.
  it('skipPermissions dissolves the rules with the other axes', () => {
    const p = resolvePosture({
      toolMode: 'read-only',
      confirmMode: 'strict',
      writeScope: { workspace: '/w' },
      toolPermissions: [{ effect: 'deny', tool: 'web_read', _v: 2 }],
      skipPermissions: true,
    });
    expect(p.toolPermissions).toBeNull();
    expect(p.writeScope).toBeNull();
  });

  it('wires the posture into ctx.policyDecision so both gates see it', async () => {
    await runHeadless(
      opts({
        posture: resolvePosture({
          toolMode: 'read-only',
          confirmMode: 'strict',
          writeScope: null,
          toolPermissions: null,
        }),
      }),
    );
    const ctx = mockRunDefinition.mock.calls[0][0];
    expect(ctx.policyDecision.toolMode).toEqual({
      mode: 'read-only',
      requireConfirmForWrite: true,
      confirmThreshold: 'medium',
    });
  });

  it('returns a failure result rather than throwing when the dispatch throws', async () => {
    mockRunDefinition.mockRejectedValue(new Error('model exploded'));
    const res = await runHeadless(opts());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('model exploded');
      expect(res.timedOut).toBe(false);
    }
  });

  it('does not classify the failure — the caller owns that decision', async () => {
    mockRunDefinition.mockRejectedValue(new Error('401 unauthorized'));
    const res = await runHeadless(opts());
    expect(res).not.toHaveProperty('classification');
    expect(res).not.toHaveProperty('category');
  });

  it('closes MCP when context assembly throws, rather than leaking its children', async () => {
    mockAssembleContext.mockImplementationOnce(() => {
      throw new Error('store unwritable');
    });
    await expect(runHeadless(opts())).rejects.toThrow('store unwritable');
    expect(mockMcpManager.close).toHaveBeenCalledTimes(1);
  });

  it('closes MCP when buildInput throws', async () => {
    await runHeadless(
      opts({
        buildInput: () => {
          throw new Error('bad payload');
        },
      }),
    );
    expect(mockMcpManager.close).toHaveBeenCalledTimes(1);
  });

  it('closes MCP even when the dispatch throws', async () => {
    mockRunDefinition.mockRejectedValue(new Error('boom'));
    await runHeadless(opts());
    expect(mockMcpManager.close).toHaveBeenCalledTimes(1);
  });

  it('closes MCP on the success path too', async () => {
    await runHeadless(opts());
    expect(mockMcpManager.close).toHaveBeenCalledTimes(1);
  });

  it('aborts on the wall clock and reports it as a timeout', async () => {
    mockRunDefinition.mockImplementation(
      (_ctx: any, _def: any, _input: any, o: any) =>
        new Promise((_resolve, reject) => {
          o.abortSignal.addEventListener('abort', () => reject(new Error('Aborted')));
        }),
    );
    const res = await runHeadless(opts({ timeoutMs: 10 }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.timedOut).toBe(true);
      expect(res.timeoutMs).toBe(10);
    }
  });

  it('composes the caller signal with the wall clock', async () => {
    const caller = new AbortController();
    // Handles the already-aborted case as well as the event, because the
    // caller may abort during MCP connect — i.e. before runHeadless has
    // attached its listener — and the composed signal is then born aborted.
    mockRunDefinition.mockImplementation(
      (_ctx: any, _def: any, _input: any, o: any) =>
        new Promise((_resolve, reject) => {
          if (o.abortSignal.aborted) return reject(new Error('Aborted'));
          o.abortSignal.addEventListener('abort', () => reject(new Error('Aborted')));
        }),
    );
    const p = runHeadless(opts({ abortSignal: caller.signal }));
    caller.abort();
    const res = await p;
    expect(res.ok).toBe(false);
    // The caller aborted, not the clock — the distinction drives the message
    // each caller mints.
    if (!res.ok) expect(res.timedOut).toBe(false);
  });

  it('honours a caller signal that was already aborted before the call', async () => {
    mockRunDefinition.mockImplementation((_ctx: any, _def: any, _input: any, o: any) => {
      if (o.abortSignal.aborted) return Promise.reject(new Error('Aborted'));
      return Promise.resolve({ formatted: 'done', stepLimitHit: false });
    });
    const res = await runHeadless(opts({ abortSignal: AbortSignal.abort() }));
    expect(res.ok).toBe(false);
  });

  it('reports the MCP cold-start cost on both branches', async () => {
    const ok = await runHeadless(opts());
    expect(ok.timings.mcpConnectMs).toEqual(expect.any(Number));
    expect(ok.timings.totalMs).toEqual(expect.any(Number));

    mockRunDefinition.mockRejectedValue(new Error('boom'));
    const failed = await runHeadless(opts());
    expect(failed.timings.mcpConnectMs).toEqual(expect.any(Number));
  });

  it('exposes the assembled context on the failure branch so callers can still read checks', async () => {
    mockRunDefinition.mockRejectedValue(new Error('boom'));
    const res = await runHeadless(opts());
    expect(res.env.ctx).toBeDefined();
    expect(res.env.runId).toEqual(expect.any(String));
  });
});
