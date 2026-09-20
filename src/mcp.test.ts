import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock external dependencies before importing MCPManager
vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(),
}));

vi.mock('@ai-sdk/mcp/mcp-stdio', () => ({
  // Each construction returns an object with its own `close` spy so a test can
  // assert the spawned child is torn down even when the client never resolves.
  Experimental_StdioMCPTransport: vi.fn(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('./output.js', () => ({
  printInfo: vi.fn(),
  printError: vi.fn(),
}));

vi.mock('ai', () => ({
  jsonSchema: (schema: any) => ({ _jsonSchema: schema }),
}));

// `openSessionSidecarFd` is the other import `mcp.ts` takes from here; without
// it the stderr-capture tests lose their target.
vi.mock('./logger.js', async () => {
  const actual = await vi.importActual<typeof import('./logger.js')>('./logger.js');
  return { ...actual, debugLog: vi.fn() };
});

const { createMCPClient } = await import('@ai-sdk/mcp');
const { debugLog } = await import('./logger.js');
const { printInfo, printError } = await import('./output.js');
const { MCPManager, verifyMCPServer } = await import('./mcp.js');
const { mcpToolName } = await import('./mcp-names.js');
const { readToolMeta } = await import('./framework/tools/adapter.js');
const { Experimental_StdioMCPTransport } = await import('@ai-sdk/mcp/mcp-stdio');
const mockStdioTransport = Experimental_StdioMCPTransport as unknown as ReturnType<typeof vi.fn>;

const mockCreateMCPClient = createMCPClient as ReturnType<typeof vi.fn>;
const mockPrintInfo = printInfo as ReturnType<typeof vi.fn>;
const mockPrintError = printError as ReturnType<typeof vi.fn>;

function makeMockClient(toolsMap: Record<string, any>) {
  return {
    tools: vi.fn().mockResolvedValue(toolsMap),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDynamicTool(executeFn: (...args: any[]) => any) {
  return {
    type: 'dynamic',
    inputSchema: { jsonSchema: { type: 'object', properties: {} } },
    description: 'test tool',
    execute: executeFn,
  };
}

/**
 * Connects `spec` = `{ serverName: [rawToolName, …] }` and returns the manager.
 * Each tool's execute resolves to `<server>:<tool>` so a test can assert which
 * client a call actually reached.
 */
async function connectServers(
  manager: InstanceType<typeof MCPManager>,
  spec: Record<string, string[]>,
): Promise<void> {
  const clients = Object.fromEntries(
    Object.entries(spec).map(([server, tools]) => [
      server,
      makeMockClient(
        Object.fromEntries(
          tools.map((t) => [t, makeDynamicTool(vi.fn().mockResolvedValue(`${server}:${t}`))]),
        ),
      ),
    ]),
  );
  const order = Object.keys(spec);
  let n = 0;
  mockCreateMCPClient.mockImplementation(async () => clients[order[n++]]);
  vi.spyOn(manager, 'loadConfig').mockReturnValue({
    mcpServers: Object.fromEntries(order.map((s) => [s, { url: `http://${s}` }])),
  });
  await manager.connect();
}

describe('MCPManager reconnection', () => {
  let manager: InstanceType<typeof MCPManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MCPManager();
  });

  /**
   * Helper: set up manager with a single MCP server that has given tools.
   * Directly populates internal state to avoid mocking loadConfig/connect flow.
   */
  async function setupWithServer(
    serverName: string,
    tools: Record<string, any>,
    config: { url: string } = { url: 'http://test-server' },
  ) {
    const client = makeMockClient(tools);
    mockCreateMCPClient.mockResolvedValue(client);

    // Use loadConfig mock to inject server config, then call connect
    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: { [serverName]: config },
    });

    await manager.connect();
    return client;
  }

  describe('outbound argument folding, narrowed to prose (#442)', () => {
    /**
     * The asymmetry this closes: the wrapper normalized the RESULT and handed
     * the ARGS straight through — one parameter position apart — which is how a
     * plain em dash reached a Gmail MCP server that writes raw UTF-8 into a
     * `Subject:` header and came back as `Ã¢Â€Â”`.
     *
     * It shipped folding EVERY argument, and that default was reversed because
     * `mcp.ts` has no notion of argument kind: folding a JSON document, a URL, a
     * path, an XPath, a regex or a selector corrupts it. `mcp-prose-args.ts` is
     * the narrowing that lets it be default-on again, and the cases below are
     * the two halves of that bargain — the em dash in a subject goes, and every
     * shape the blanket fold broke survives.
     *
     * The narrowing's own table and value guards are tested in
     * `mcp-prose-args.test.ts`; these assert it is actually WIRED, on the args
     * the server really receives, including on the retry path.
     */
    const original = process.env.BERNARD_ASCII_OUTBOUND;
    afterEach(() => {
      if (original === undefined) delete process.env.BERNARD_ASCII_OUTBOUND;
      else process.env.BERNARD_ASCII_OUTBOUND = original;
    });

    it('folds a declared prose argument in the args the server actually receives', async () => {
      const executeFn = vi.fn().mockResolvedValue('sent');
      await setupWithServer('test-server', { send_email: makeDynamicTool(executeFn) });

      await manager
        .getTools()
        [mcpToolName('test-server', 'send_email')].execute({ subject: 'Daily Blaze — Wed 9/9' });

      expect(executeFn.mock.calls[0][0]).toEqual({ subject: 'Daily Blaze - Wed 9/9' });
    });

    it('leaves every shape the blanket fold corrupted alone', async () => {
      // The measured corruption list from `asciiOutboundEnabled`'s docstring,
      // sent as arguments of a tool that DOES emit — so the only thing standing
      // between them and the fold is the argument-name table. A JSON document in
      // a `body` is there deliberately: `body` IS declared prose, so that one is
      // refused by the value guard rather than by the name.
      const executeFn = vi.fn().mockResolvedValue('sent');
      await setupWithServer('test-server', { send_email: makeDynamicTool(executeFn) });

      const args = {
        selector: 'text=Sign in — it’s free',
        url: 'https://ex.com/a–b?q=x',
        path: '/home/u/Don’t Panic – notes.md',
        pattern: 'loading…$',
        content: 'see ‹note› below',
        body: '{"note":"a — b","q":"“x”"}',
      };
      await manager.getTools()[mcpToolName('test-server', 'send_email')].execute(args);

      expect(executeFn.mock.calls[0][0]).toEqual(args);
      // The JSON body still parses, which is the whole point of the guard.
      expect(() => JSON.parse((executeFn.mock.calls[0][0] as typeof args).body)).not.toThrow();
    });

    it('leaves meaning-bearing characters alone', async () => {
      // The boundary: these break in a naive consumer exactly the same way an em
      // dash does, but folding them destroys content rather than normalizing it.
      const executeFn = vi.fn().mockResolvedValue('sent');
      await setupWithServer('test-server', { send_email: makeDynamicTool(executeFn) });

      const args = { to: 'José', body: '日本語 🎉 €5' };
      await manager.getTools()[mcpToolName('test-server', 'send_email')].execute(args);

      expect(executeFn.mock.calls[0][0]).toEqual(args);
    });

    it('stays off entirely when explicitly disabled', async () => {
      process.env.BERNARD_ASCII_OUTBOUND = 'false';
      const executeFn = vi.fn().mockResolvedValue('sent');
      await setupWithServer('test-server', { send_email: makeDynamicTool(executeFn) });

      await manager
        .getTools()
        [mcpToolName('test-server', 'send_email')].execute({ subject: 'a — b' });

      expect(executeFn.mock.calls[0][0]).toEqual({ subject: 'a — b' });
    });

    it('does not fold a tool its own server declared read-only', async () => {
      // `emitsProse`'s stated harm is rewriting a lookup's SEARCH TERM, and
      // until #570 the only thing standing between that and a badly-named read
      // tool was the name. `send_email` carries a write verb and an emit verb,
      // so without the hand-off of the resolved `isRead` this folds.
      const executeFn = vi.fn().mockResolvedValue('found');
      await setupWithServer('test-server', {
        send_email: {
          ...makeDynamicTool(executeFn),
          metadata: { annotations: { readOnlyHint: true } },
        },
      });

      await manager
        .getTools()
        [mcpToolName('test-server', 'send_email')].execute({ subject: 'a — b' });

      expect(executeFn.mock.calls[0][0]).toEqual({ subject: 'a — b' });
      // Guard the guard: the same fixture without the annotation IS folded, so
      // the assertion above is a verdict rather than a broken harness.
      const control = vi.fn().mockResolvedValue('sent');
      const m2 = new MCPManager();
      mockCreateMCPClient.mockResolvedValue(
        makeMockClient({ send_email: makeDynamicTool(control) }),
      );
      vi.spyOn(m2, 'loadConfig').mockReturnValue({ mcpServers: { srv: { url: 'http://s' } } });
      await m2.connect();
      await m2.getTools()[mcpToolName('srv', 'send_email')].execute({ subject: 'a — b' });
      expect(control.mock.calls[0][0]).toEqual({ subject: 'a - b' });
    });

    /**
     * The predecessor of this block asserted "sends the FOLDED args on the
     * reconnect retry too", and that test is now UNREACHABLE rather than merely
     * deleted — which is worth writing down, because the obvious reading of its
     * absence is that somebody dropped coverage.
     *
     * `emitsProse` and `ToolMeta.nonIdempotent` are the same predicate
     * (`!isRead && hasEmitVerb`), because they are the same question asked twice:
     * does this tool put an artefact in front of a person. So every tool whose
     * arguments the fold touches is also a tool #594 refuses to retry, and every
     * tool that reaches the retry gets `args` back by identity from
     * `foldProseArgs`. The fold on the retry path is provably a no-op.
     *
     * **"Provably" now means on the NAME path.** Since #570 a server can declare
     * `readOnlyHint: false` with `idempotentHint: true` on a name carrying an
     * emit verb, which makes `nonIdempotent` false while `emitsProse` stays
     * true — so a folded call really can reach the retry.
     *
     * The retry still passes `outbound` rather than `args`, and that is what
     * makes the divergence harmless rather than a bug: the retry re-sends the
     * same folded payload to a tool its own server said is safe to repeat. It
     * was written as insurance "should the predicates ever diverge"; they have.
     * The coincidence is pinned by `mcp-prose-args.test.ts`'s "a foldable tool
     * is never retried", which states the same restriction.
     */
  });

  it('tool call succeeds normally without reconnection', async () => {
    const executeFn = vi.fn().mockResolvedValue('success');
    await setupWithServer('test-server', { myTool: makeDynamicTool(executeFn) });

    const tools = manager.getTools();
    const result = await tools[mcpToolName('test-server', 'myTool')].execute({ query: 'hello' });

    expect(result).toBe('success');
    // `mock.calls[0][0]`, not `toHaveBeenCalledWith`: the wrapper forwards the
    // AI SDK's `ToolExecutionOptions` now (#594), so every call carries a second
    // argument. What this asserts is the args, not the arity.
    expect(executeFn.mock.calls[0][0]).toEqual({ query: 'hello' });
    expect(mockPrintInfo).not.toHaveBeenCalledWith(expect.stringContaining('reconnecting'));
  });

  it('reconnects and retries successfully after tool failure', async () => {
    const failExecute = vi.fn().mockRejectedValue(new Error('SSE stream disconnected'));
    await setupWithServer('test-server', { myTool: makeDynamicTool(failExecute) });

    // Get tools (these wrap the failing execute)
    const tools = manager.getTools();

    // Set up reconnection: createMCPClient returns a new client with working tools
    const successExecute = vi.fn().mockResolvedValue('reconnected-result');
    const newClient = makeMockClient({ myTool: makeDynamicTool(successExecute) });
    mockCreateMCPClient.mockResolvedValue(newClient);

    const result = await tools[mcpToolName('test-server', 'myTool')].execute({ query: 'retry' });

    expect(result).toBe('reconnected-result');
    expect(failExecute).toHaveBeenCalledTimes(1);
    expect(successExecute).toHaveBeenCalledTimes(1);
    // The debug log, and deliberately NOT stdout. This runs while Ink owns the
    // screen — in full-screen it owns the alternate buffer — so a `printInfo`
    // here lands at the cursor, corrupts the live frame, and is painted over on
    // the next render: the line least likely to be read. It also fires between
    // turns now that a watcher poll calls MCP tools (#479), where there is no
    // turn output to hide behind.
    expect(debugLog).toHaveBeenCalledWith('mcp:tool-retry', {
      tool: 'myTool',
      server: 'test-server',
    });
    expect(mockPrintInfo).not.toHaveBeenCalledWith(expect.stringContaining('reconnecting'));
  });

  it('surfaces original error when reconnection fails', async () => {
    const failExecute = vi.fn().mockRejectedValue(new Error('SSE stream disconnected'));
    await setupWithServer('test-server', { myTool: makeDynamicTool(failExecute) });

    const tools = manager.getTools();

    // Reconnection itself fails
    mockCreateMCPClient.mockRejectedValue(new Error('connection refused'));

    await expect(
      tools[mcpToolName('test-server', 'myTool')].execute({ query: 'fail' }),
    ).rejects.toThrow('SSE stream disconnected');
    expect(mockPrintError).toHaveBeenCalledWith(
      'MCP reconnection to "test-server" failed: connection refused',
    );
  });

  it('surfaces retry error when reconnection succeeds but retry fails', async () => {
    const failExecute = vi.fn().mockRejectedValue(new Error('SSE stream disconnected'));
    await setupWithServer('test-server', { myTool: makeDynamicTool(failExecute) });

    const tools = manager.getTools();

    // Reconnection succeeds but the new tool also fails
    const retryFailExecute = vi.fn().mockRejectedValue(new Error('retry also failed'));
    const newClient = makeMockClient({ myTool: makeDynamicTool(retryFailExecute) });
    mockCreateMCPClient.mockResolvedValue(newClient);

    await expect(
      tools[mcpToolName('test-server', 'myTool')].execute({ query: 'fail' }),
    ).rejects.toThrow('retry also failed');
  });

  it('tracks tool-to-server mapping correctly', async () => {
    const exec1 = vi.fn().mockResolvedValue('r1');
    const exec2 = vi.fn().mockResolvedValue('r2');

    // Set up two servers
    const client1 = makeMockClient({
      toolA: makeDynamicTool(exec1),
    });
    const client2 = makeMockClient({
      toolB: makeDynamicTool(exec2),
    });

    let callCount = 0;
    mockCreateMCPClient.mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? client1 : client2;
    });

    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: {
        server1: { url: 'http://server1' },
        server2: { url: 'http://server2' },
      },
    });

    await manager.connect();

    const tools = manager.getTools();
    const a = tools[mcpToolName('server1', 'toolA')];
    const b = tools[mcpToolName('server2', 'toolB')];
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    // Both work normally
    expect(await a.execute({})).toBe('r1');
    expect(await b.execute({})).toBe('r2');
  });

  it('reconnectServer returns false for unknown server', async () => {
    const result = await manager.reconnectServer('nonexistent');
    expect(result).toBe(false);
  });

  it('reconnectServer updates server status on success', async () => {
    const executeFn = vi.fn().mockResolvedValue('ok');
    await setupWithServer('test-server', { myTool: makeDynamicTool(executeFn) });

    // Reconnect with a new tool set
    const newExec = vi.fn().mockResolvedValue('new-ok');
    const newClient = makeMockClient({
      myTool: makeDynamicTool(newExec),
      extraTool: makeDynamicTool(newExec),
    });
    mockCreateMCPClient.mockResolvedValue(newClient);

    const result = await manager.reconnectServer('test-server');
    expect(result).toBe(true);

    const statuses = manager.getServerStatuses();
    const status = statuses.find((s) => s.name === 'test-server');
    expect(status).toEqual({ name: 'test-server', connected: true, toolCount: 2 });
  });
});

describe('MCPManager schema pass-through', () => {
  it('passes the MCP tool schema to jsonSchema unchanged (no normalization)', async () => {
    // OpenAI strict mode is off, so we no longer rewrite incoming schemas. Verify
    // that a schema with full JSON Schema features (oneOf, no additionalProperties,
    // untyped items) reaches the AI SDK exactly as the MCP server emitted it.
    vi.clearAllMocks();
    const manager = new MCPManager();
    const richSchema = {
      type: 'object',
      properties: {
        attachments: {
          type: 'array',
          items: {
            oneOf: [{ required: ['filePath'] }, { required: ['driveFileId'] }],
          },
        },
      },
    };
    const tools = {
      richTool: {
        type: 'dynamic',
        inputSchema: { jsonSchema: richSchema },
        description: 'tool with rich schema',
        execute: vi.fn(),
      },
    };
    const client = makeMockClient(tools);
    mockCreateMCPClient.mockResolvedValue(client);
    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: { 'rich-server': { url: 'http://rich-server' } },
    });
    await manager.connect();

    const out = manager.getTools();
    expect(out[mcpToolName('rich-server', 'richTool')].parameters).toEqual({
      _jsonSchema: richSchema,
    });
  });
});

describe('MCPManager connect timeout (#254)', () => {
  let manager: InstanceType<typeof MCPManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('BERNARD_MCP_CONNECT_TIMEOUT_MS', '60');
    manager = new MCPManager();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a hung handshake does not block connect(); the server is marked failed and its child killed', async () => {
    // Mirrors the Figma/Framelink case: an HTTP server launched as stdio, so
    // createMCPClient never resolves.
    mockCreateMCPClient.mockReturnValue(new Promise(() => {}));
    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: { hung: { command: 'npx', args: ['figma-developer-mcp'] } },
    });

    await manager.connect();

    const status = manager.getServerStatuses().find((s) => s.name === 'hung');
    expect(status?.connected).toBe(false);
    expect(status?.error).toMatch(/timed out/i);
    expect(mockPrintError).toHaveBeenCalledWith(
      expect.stringContaining('MCP server "hung" failed to connect'),
    );
    // The spawned stdio child is torn down via the transport even though the
    // client never resolved (no client.close() possible).
    const transportInstance = mockStdioTransport.mock.results.at(-1)?.value;
    expect(transportInstance.close).toHaveBeenCalledTimes(1);
  });

  it('healthy servers still connect when another server hangs', async () => {
    const healthyClient = makeMockClient({ goodTool: makeDynamicTool(vi.fn()) });
    mockCreateMCPClient.mockImplementation((opts: any) =>
      opts.transport?.url === 'http://healthy'
        ? Promise.resolve(healthyClient)
        : new Promise(() => {}),
    );
    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: {
        healthy: { url: 'http://healthy' },
        hung: { command: 'npx', args: ['broken-mcp'] },
      },
    });

    await manager.connect();

    const statuses = manager.getServerStatuses();
    expect(statuses.find((s) => s.name === 'healthy')).toEqual({
      name: 'healthy',
      connected: true,
      toolCount: 1,
    });
    expect(statuses.find((s) => s.name === 'hung')?.connected).toBe(false);
    expect(manager.getTools()[mcpToolName('healthy', 'goodTool')]).toBeDefined();
  });

  it('a hung tools() listing also trips the timeout and closes the client', async () => {
    const client = {
      tools: vi.fn().mockReturnValue(new Promise(() => {})),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockCreateMCPClient.mockResolvedValue(client);
    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: { slow: { url: 'http://slow' } },
    });

    await manager.connect();

    const status = manager.getServerStatuses().find((s) => s.name === 'slow');
    expect(status?.connected).toBe(false);
    expect(status?.error).toMatch(/timed out/i);
    expect(client.close).toHaveBeenCalled();
  });

  it('reconnectServer times out instead of hanging and marks the server failed', async () => {
    const client = makeMockClient({ myTool: makeDynamicTool(vi.fn()) });
    mockCreateMCPClient.mockResolvedValue(client);
    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: { 'test-server': { url: 'http://test-server' } },
    });
    await manager.connect();

    mockCreateMCPClient.mockReturnValue(new Promise(() => {}));
    const result = await manager.reconnectServer('test-server');

    expect(result).toBe(false);
    const status = manager.getServerStatuses().find((s) => s.name === 'test-server');
    expect(status?.connected).toBe(false);
    expect(status?.error).toMatch(/timed out/i);
  });
});

describe('verifyMCPServer', () => {
  beforeEach(() => {
    mockCreateMCPClient.mockReset();
  });

  it('reports ok with the tool count for a server that connects', async () => {
    const client = makeMockClient({ alpha: {}, beta: {}, gamma: {} });
    mockCreateMCPClient.mockResolvedValue(client);
    const r = await verifyMCPServer({ command: 'npx', args: ['some-mcp'] });
    expect(r.ok).toBe(true);
    expect(r.toolCount).toBe(3);
    expect(r.toolNames).toEqual(['alpha', 'beta', 'gamma']);
    expect(r.timedOut).toBe(false);
    expect(client.close).toHaveBeenCalled(); // cleaned up after probing
  });

  it('connects a URL server via the sse transport', async () => {
    mockCreateMCPClient.mockResolvedValue(makeMockClient({ x: {} }));
    const r = await verifyMCPServer({ url: 'http://127.0.0.1:3333/sse' });
    expect(r.ok).toBe(true);
    expect(mockCreateMCPClient).toHaveBeenCalledWith({
      transport: { type: 'sse', url: 'http://127.0.0.1:3333/sse', headers: undefined },
    });
  });

  it('reports a connection error (not a timeout) when the client rejects', async () => {
    mockCreateMCPClient.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await verifyMCPServer({ command: 'node', args: ['missing.js'] });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });

  it('times out (and flags timedOut) when the handshake never completes', async () => {
    // Mirrors an HTTP server launched as stdio: createMCPClient never resolves.
    mockStdioTransport.mockClear();
    mockCreateMCPClient.mockReturnValue(new Promise(() => {}));
    const r = await verifyMCPServer(
      { command: 'npx', args: ['figma-developer-mcp'] },
      { timeoutMs: 60 },
    );
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toMatch(/--stdio|handshake|HTTP/i);
    // The spawned stdio child is torn down via the transport even though the
    // client never resolved (no client.close() possible).
    const transportInstance = mockStdioTransport.mock.results.at(-1)?.value;
    expect(transportInstance.close).toHaveBeenCalledTimes(1);
  });
});

describe('MCPManager.getLiveRegistration', () => {
  let manager: InstanceType<typeof MCPManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MCPManager();
  });

  // Rewritten for #413. This test used to pin last-writer-wins as INTENDED
  // behaviour: A's `shared` was reported shadowed by B. Namespacing makes that
  // unrepresentable, so the property to pin is the opposite one — a name two
  // servers export is live for both.
  it('reports a name both servers export as live for each of them', async () => {
    const clientA = makeMockClient({
      shared: makeDynamicTool(vi.fn()),
      onlyA: makeDynamicTool(vi.fn()),
    });
    const clientB = makeMockClient({
      shared: makeDynamicTool(vi.fn()),
      onlyB: makeDynamicTool(vi.fn()),
    });
    let n = 0;
    mockCreateMCPClient.mockImplementation(async () => (++n === 1 ? clientA : clientB));
    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: { serverA: { url: 'http://a' }, serverB: { url: 'http://b' } },
    });
    await manager.connect();

    const regA = manager.getLiveRegistration('serverA', ['shared', 'onlyA', 'ghost']);
    expect(regA.connected).toBe(true);
    expect(regA.live.sort()).toEqual(['onlyA', 'shared']);
    expect(regA.missing).toEqual(['ghost']); // registered by nobody

    const regB = manager.getLiveRegistration('serverB', ['shared', 'onlyB']);
    expect(regB.live.sort()).toEqual(['onlyB', 'shared']);
    expect(regB.missing).toEqual([]);
  });

  // The regression this phase was most likely to ship silently. `verifyMCPServer`
  // probes a server in isolation and reports the RAW names it exports, while the
  // registry is keyed by namespaced names — compare them directly and every tool
  // of every healthy server reads as `missing`, which `mcp_verify` renders as a
  // ⚠ verdict. `mcp-verify.test.ts` mocks `getLiveRegistration`, so it cannot
  // catch this; only driving the real one with real probe names can.
  it('maps raw probe names forward, so a healthy server reports nothing missing', async () => {
    const raw = ['browser_click', 'browser_type', 'browser_navigate'];
    mockCreateMCPClient.mockResolvedValue(
      makeMockClient(Object.fromEntries(raw.map((n) => [n, makeDynamicTool(vi.fn())]))),
    );
    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: { playwright: { url: 'http://p' } },
    });
    await manager.connect();

    const reg = manager.getLiveRegistration('playwright', raw);

    expect(reg.missing).toEqual([]);
    expect(reg.live.sort()).toEqual([...raw].sort());
  });

  it('reports connected:false and all-missing for a server that failed to connect', async () => {
    mockCreateMCPClient.mockRejectedValue(new Error('boom'));
    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: { down: { url: 'http://d' } },
    });
    await manager.connect();

    const reg = manager.getLiveRegistration('down', ['x', 'y']);
    expect(reg.connected).toBe(false);
    expect(reg.live).toEqual([]);
    expect(reg.missing).toEqual(['x', 'y']);
  });
});

describe('MCP stdio stderr capture', () => {
  let manager: InstanceType<typeof MCPManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MCPManager();
    mockCreateMCPClient.mockResolvedValue(makeMockClient({ aTool: makeDynamicTool(vi.fn()) }));
    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: { noisy: { command: 'npx', args: ['@browsermcp/mcp@latest'] } },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The AI SDK's transport defaults stderr to 'inherit', which puts a
  // third-party server's output straight onto the terminal — into the
  // alternate screen buffer Ink owns in full-screen mode. Never leave it
  // unset.
  it('never lets a spawned server inherit the terminal', async () => {
    vi.stubEnv('BERNARD_DEBUG', '');

    await manager.connect();

    const config = mockStdioTransport.mock.calls.at(-1)?.[0];
    expect(config.stderr).toBe('ignore');
  });

  // 'pipe' would be a hang, not a fix: the transport keeps its child private,
  // so nothing drains the pipe and the server blocks once the kernel buffer
  // fills. Debug capture has to be a descriptor.
  it('captures to a file descriptor under BERNARD_DEBUG, never a pipe', async () => {
    vi.stubEnv('BERNARD_DEBUG', '1');

    await manager.connect();

    const config = mockStdioTransport.mock.calls.at(-1)?.[0];
    expect(typeof config.stderr).toBe('number');
  });
});

// #413: the flat registry was last-writer-wins, so a server exporting a name
// another server already owned silently lost that tool from its OWN per-server
// list — measured, `playwright` kept 17 of its 24 tools. The per-server map is
// the fix, and these pin the property rather than the mechanism.
describe('MCPManager per-server registry (#413)', () => {
  let manager: InstanceType<typeof MCPManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MCPManager();
  });

  const twoSharing = () =>
    connectServers(manager, { serverA: ['shared', 'onlyA'], serverB: ['shared', 'onlyB'] });

  it('both servers keep every tool they export, collision included', async () => {
    await twoSharing();

    const perServer = manager.getServerTools();
    expect(Object.keys(perServer.serverA).sort()).toEqual(
      [mcpToolName('serverA', 'onlyA'), mcpToolName('serverA', 'shared')].sort(),
    );
    expect(Object.keys(perServer.serverB).sort()).toEqual(
      [mcpToolName('serverB', 'onlyB'), mcpToolName('serverB', 'shared')].sort(),
    );
  });

  // The regression that started the issue: a server's advertised tool count and
  // the tools a delegate helper can actually reach must agree.
  it("each server's tool count matches what it actually kept", async () => {
    await twoSharing();

    const perServer = manager.getServerTools();
    for (const status of manager.getServerStatuses()) {
      expect(Object.keys(perServer[status.name])).toHaveLength(status.toolCount);
    }
  });

  it('snapshot derives the flat bag from the per-server map, sharing identities', async () => {
    await twoSharing();

    const snap = manager.snapshot();
    const aKey = mcpToolName('serverA', 'onlyA');
    const bKey = mcpToolName('serverB', 'onlyB');
    expect(snap.tools[aKey]).toBe(snap.serverTools.serverA[aKey]);
    expect(snap.tools[bKey]).toBe(snap.serverTools.serverB[bKey]);
  });

  // A dead server used to keep its tools registered, so its stale entry went on
  // occupying a name a healthy server also exported — with no way to fall back.
  it('a failed reconnect drops only that server, leaving the other callable', async () => {
    await twoSharing();

    mockCreateMCPClient.mockRejectedValue(new Error('down'));
    expect(await manager.reconnectServer('serverB')).toBe(false);

    const perServer = manager.getServerTools();
    expect(perServer.serverB).toBeUndefined();
    expect(Object.keys(perServer.serverA).sort()).toEqual(
      [mcpToolName('serverA', 'onlyA'), mcpToolName('serverA', 'shared')].sort(),
    );
    expect(manager.getTools()[mcpToolName('serverA', 'shared')]).toBeDefined();
  });
});

describe('MCPManager namespaced names (#413)', () => {
  let manager: InstanceType<typeof MCPManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MCPManager();
  });

  const twoClickers = () =>
    connectServers(manager, { playwright: ['browser_click'], browsermcp: ['browser_click'] });

  // The exact regression from the issue: both servers keep the name, and each
  // routes to its own client.
  it('registers both servers browser_click and routes each to its own client', async () => {
    await twoClickers();

    const tools = manager.getTools();
    const pw = tools[mcpToolName('playwright', 'browser_click')];
    const bm = tools[mcpToolName('browsermcp', 'browser_click')];
    expect(pw).toBeDefined();
    expect(bm).toBeDefined();
    expect(await pw.execute({})).toBe('playwright:browser_click');
    expect(await bm.execute({})).toBe('browsermcp:browser_click');
  });

  // The permission and block gates key on the registry key; the deterministic
  // result cache keys on `meta.name`. If those ever diverge the two silently
  // stop describing the same tool.
  it('keeps meta.name in lockstep with the registry key', async () => {
    await twoClickers();

    for (const [key, tool] of Object.entries(manager.getTools())) {
      expect(readToolMeta(tool)?.name).toBe(key);
    }
  });

  // Risk is classified from the RAW name, not the key. The classifier strips
  // the namespace itself, so an ordinary key would survive either way — but an
  // R2-truncated key's tail is the tool's tail, not its verb.
  it('classifies read vs write from the raw tool name', async () => {
    mockCreateMCPClient.mockResolvedValue(
      makeMockClient({
        brave_search: makeDynamicTool(vi.fn()),
        browser_click: makeDynamicTool(vi.fn()),
      }),
    );
    vi.spyOn(manager, 'loadConfig').mockReturnValue({ mcpServers: { srv: { url: 'http://s' } } });
    await manager.connect();

    const tools = manager.getTools();
    expect(readToolMeta(tools[mcpToolName('srv', 'brave_search')])?.kind).toBe('read');
    expect(readToolMeta(tools[mcpToolName('srv', 'browser_click')])?.kind).toBe('write');
  });

  // The duplicate gate's whole live population comes from here (#575), and
  // nothing else asserts that `mcp.ts` wires the rule: the augment fixtures
  // derive the flag themselves, so a mutation dropping `hasEmitVerb` — or the
  // field entirely — survived every one of them.
  //
  // `focus_app` is the case that decides the rule rather than an extra one. It
  // carries neither a read nor a write verb so it classifies as a WRITE, it is
  // the third most-used MCP tool on the install this was measured against, and
  // the dispatch that double-sent called it twice with identical arguments.
  // `nonIdempotent: !isRead` would refuse the second one.
  it('marks only the emitting writes non-idempotent', async () => {
    mockCreateMCPClient.mockResolvedValue(
      makeMockClient({
        send_message: makeDynamicTool(vi.fn()),
        focus_app: makeDynamicTool(vi.fn()),
        list_messages: makeDynamicTool(vi.fn()),
      }),
    );
    vi.spyOn(manager, 'loadConfig').mockReturnValue({ mcpServers: { srv: { url: 'http://s' } } });
    await manager.connect();

    const tools = manager.getTools();
    const flag = (t: string) => readToolMeta(tools[mcpToolName('srv', t)])?.nonIdempotent;
    expect(flag('send_message')).toBe(true);
    expect(flag('focus_app')).toBe(false);
    expect(flag('list_messages')).toBe(false);
  });

  /**
   * The name guess is now the fallback, not the answer (#570).
   *
   * `classifyMCPTool` is unit-tested in `risk.test.ts`; what is only testable
   * here is the WIRING — that `mcp.ts` reads `tool.metadata.annotations` off
   * what `client.tools()` returns and feeds it in. That plumbing is the half
   * that fails silently: a hint read from the wrong property, or not read at
   * all, leaves every other assertion in this file green, because they all use
   * unannotated fixtures.
   *
   * `metadata.annotations` is where `@ai-sdk/mcp@1.0.82` puts them — verified
   * over a real stdio transport against both 1.0.21, which drops them entirely,
   * and 1.0.82.
   */
  describe('server annotations', () => {
    const annotated = (annotations: Record<string, unknown>) => ({
      ...makeDynamicTool(vi.fn()),
      metadata: { clientName: 'ai-sdk-mcp-client', annotations },
    });

    async function connectAnnotated() {
      mockCreateMCPClient.mockResolvedValue(
        makeMockClient({
          // Name says write AND emits; server says read-only.
          send_report: annotated({ readOnlyHint: true }),
          // Name says read; server says it writes and is not repeatable.
          list_things: annotated({ readOnlyHint: false, idempotentHint: false }),
          // Name says it emits; server says repeating is harmless.
          send_message: annotated({ idempotentHint: true }),
          // The control: no annotations, decided by the name exactly as before.
          google_gmail_list_emails: makeDynamicTool(vi.fn()),
        }),
      );
      vi.spyOn(manager, 'loadConfig').mockReturnValue({ mcpServers: { srv: { url: 'http://s' } } });
      await manager.connect();
      const tools = manager.getTools();
      return (t: string) => readToolMeta(tools[mcpToolName('srv', t)]);
    }

    it('prefers readOnlyHint over the name, in both directions', async () => {
      const meta = await connectAnnotated();
      // The direction that unblocks a lookup nobody named well...
      expect(meta('send_report')?.kind).toBe('read');
      expect(meta('send_report')?.sideEffect).toBe('network');
      // ...and the one #570 calls the worse of the two, where our regex
      // currently overrides a server that explicitly said "this writes".
      expect(meta('list_things')?.kind).toBe('write');
      expect(meta('list_things')?.sideEffect).toBe('local');
    });

    it('prefers idempotentHint over the emit-verb guess', async () => {
      const meta = await connectAnnotated();
      expect(meta('list_things')?.nonIdempotent).toBe(true);
      // `send_message` is the name the guess gets right and the server
      // overrules — so this fails if `idempotentHint` is dropped on the way in.
      expect(meta('send_message')?.nonIdempotent).toBe(false);
      // A declared read is never worth refusing a repeat of, whatever it emits.
      expect(meta('send_report')?.nonIdempotent).toBe(false);
    });

    it('leaves an unannotated tool to the name', async () => {
      const meta = await connectAnnotated();
      // Also #612's own case end to end: a read verb in the MIDDLE, which
      // classified as a medium-risk write until this change.
      expect(meta('google_gmail_list_emails')?.kind).toBe('read');
      expect(meta('google_gmail_list_emails')?.nonIdempotent).toBe(false);
    });

    it('ignores a malformed hint rather than trusting it', async () => {
      // Annotations are untrusted server data by spec, and `tool.metadata`
      // reaches `mcp.ts` as `any`. A string here must fall back to the name.
      mockCreateMCPClient.mockResolvedValue(
        makeMockClient({ send_message: annotated({ readOnlyHint: 'true' }) }),
      );
      vi.spyOn(manager, 'loadConfig').mockReturnValue({ mcpServers: { srv: { url: 'http://s' } } });
      await manager.connect();
      const meta = readToolMeta(manager.getTools()[mcpToolName('srv', 'send_message')]);
      expect(meta?.kind).toBe('write');
      expect(meta?.nonIdempotent).toBe(true);
    });

    /**
     * Which source decided, once per server per connect (#570's last acceptance
     * line: "shows which source decided, so a misclassification is diagnosable
     * without reading code").
     *
     * It is also what gives `readToolAnnotations`' own type guard an observable
     * consequence. `classifyMCPTool` guards too, so dropping the boundary one
     * changes no classification — measured, that mutation survived every other
     * assertion in this file. What it does change is the COUNT: a malformed
     * hint would read as an annotated tool, and the line whose job is to say
     * "this server declares nothing" would say the opposite.
     */
    it('logs which tools the server overruled', async () => {
      vi.stubEnv('BERNARD_DEBUG', '1');
      mockCreateMCPClient.mockResolvedValue(
        makeMockClient({
          send_report: annotated({ readOnlyHint: true }), // name says write
          list_things: annotated({ readOnlyHint: false }), // name says read
          send_message: annotated({ readOnlyHint: false }), // name agrees
          bad_hint: annotated({ readOnlyHint: 'true' }), // not a declaration
          google_gmail_list_emails: makeDynamicTool(vi.fn()), // no annotations
        }),
      );
      vi.spyOn(manager, 'loadConfig').mockReturnValue({ mcpServers: { srv: { url: 'http://s' } } });
      await manager.connect();

      expect(debugLog).toHaveBeenCalledWith('mcp:classified', {
        server: 'srv',
        tools: 5,
        // Three real declarations: the malformed one and the bare tool are not
        // annotated, which is the half the boundary guard decides.
        readFromServer: 3,
        // `send_report` is declared read-only, so the read hint settles
        // idempotency too and nothing else here declared one.
        idempotencyFromServer: 1,
        // Only the two the server actually contradicted — `send_message` agrees
        // with the guess and is not worth a reader's attention.
        overrideCount: 2,
        overrides: ['send_report', 'list_things'],
      });
    });

    it('bounds the override list and keeps the count honest', async () => {
      // A server that annotates everything can disagree with the guess on any
      // number of its tools, and this line runs once per connect into the debug
      // JSONL. `overrideCount` carries the total so the cap costs nothing but
      // bytes; without it a 200-tool server writes 200 names.
      vi.stubEnv('BERNARD_DEBUG', '1');
      const many = Object.fromEntries(
        // Each reads like a lookup and is declared a write, so every one is an
        // override.
        Array.from({ length: 14 }, (_, i) => [
          `list_things_${i}`,
          annotated({ readOnlyHint: false }),
        ]),
      );
      mockCreateMCPClient.mockResolvedValue(makeMockClient(many));
      vi.spyOn(manager, 'loadConfig').mockReturnValue({ mcpServers: { srv: { url: 'http://s' } } });
      await manager.connect();

      const line = vi
        .mocked(debugLog)
        .mock.calls.find(([label]) => label === 'mcp:classified')?.[1] as {
        overrideCount: number;
        overrides: string[];
      };
      expect(line.overrideCount).toBe(14);
      expect(line.overrides).toHaveLength(10);
    });

    it('says plainly when a server declares nothing', async () => {
      // The other useful answer, and the common one: `google-mcp` — the server
      // behind #612 — annotates none of its 61 tools, so every classification
      // under this line is a guess and the line has to say so.
      vi.stubEnv('BERNARD_DEBUG', '1');
      mockCreateMCPClient.mockResolvedValue(
        makeMockClient({ google_gmail_list_emails: makeDynamicTool(vi.fn()) }),
      );
      vi.spyOn(manager, 'loadConfig').mockReturnValue({ mcpServers: { srv: { url: 'http://s' } } });
      await manager.connect();

      expect(debugLog).toHaveBeenCalledWith('mcp:classified', {
        server: 'srv',
        tools: 1,
        readFromServer: 0,
        idempotencyFromServer: 0,
        overrideCount: 0,
        overrides: [],
      });
    });
  });

  // A name must depend only on its own server, never on config order — the
  // whole reason the segment carries a content hash rather than a suffix.
  it('produces identical keys regardless of server order in the config', async () => {
    await twoClickers();
    const first = Object.keys(manager.getTools()).sort();

    const m2 = new MCPManager();
    const a = makeMockClient({ browser_click: makeDynamicTool(vi.fn()) });
    const b = makeMockClient({ browser_click: makeDynamicTool(vi.fn()) });
    mockCreateMCPClient.mockImplementation((opts: any) =>
      Promise.resolve(opts.transport?.url === 'http://pw' ? a : b),
    );
    vi.spyOn(m2, 'loadConfig').mockReturnValue({
      mcpServers: { browsermcp: { url: 'http://bm' }, playwright: { url: 'http://pw' } },
    });
    await m2.connect();

    expect(Object.keys(m2.getTools()).sort()).toEqual(first);
  });
});

/**
 * #458/#459. The shaper's own tests pin what it cuts; this pins that the tool
 * it was cutting for reaches the log. Without the server and tool names, a
 * `mcp:result:capped` line cannot answer the question the log exists for —
 * which read lost the header.
 */
describe('MCPManager result shaping telemetry (#459)', () => {
  let manager: InstanceType<typeof MCPManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MCPManager();
  });

  function cappedLines() {
    return vi.mocked(debugLog).mock.calls.filter(([label]) => label === 'mcp:result:capped');
  }

  it('names the server and the tool whose result was cut', async () => {
    await connectOneReturning(manager, 'gmail', 'get_email', {
      content: [{ type: 'text', text: JSON.stringify({ body: 'x'.repeat(20_000) }) }],
    });
    const perServer = manager.getServerTools({ mode: 'cap', maxChars: 800 });
    await perServer.gmail[mcpToolName('gmail', 'get_email')].execute({});

    const lines = cappedLines();
    expect(lines).toHaveLength(1);
    const payload = lines[0][1] as Record<string, unknown>;
    // The RAW name, which is what the user sees in the server's own docs and in
    // `mcp_verify` — not the namespaced registry key.
    expect(payload.server).toBe('gmail');
    expect(payload.tool).toBe('get_email');
    expect(payload.rawChars).toBeGreaterThan(payload.keptChars as number);
    expect(payload.unwrapped).toBe(true);
  });

  it('says nothing for a result that fit', async () => {
    await connectOneReturning(manager, 'gmail', 'get_email', {
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
    const perServer = manager.getServerTools({ mode: 'cap', maxChars: 800 });
    await perServer.gmail[mcpToolName('gmail', 'get_email')].execute({});

    // A pass-through is not a decision worth a line, and it is the overwhelming
    // majority of calls.
    expect(cappedLines()).toHaveLength(0);
  });
});

/**
 * The probe path is unshaped ON PURPOSE (#572).
 *
 * `snapshot(shaping?)` treats absence as pass-through, so the two watcher call
 * sites were already correct — by saying nothing. `index.ts` and `headless.ts`
 * DO pass a config, which makes the bare calls read as an oversight, and
 * "make them consistent" is a one-line edit with no compile error behind it.
 * These are the tests that stop it.
 */
/**
 * Connects one server whose single tool resolves `result`.
 *
 * `connectServers` above hard-wires each tool's result to `"${server}:${t}"`,
 * so a test that cares what came BACK needs this instead.
 */
async function connectOneReturning(
  manager: MCPManager,
  server: string,
  tool: string,
  result: unknown,
): Promise<void> {
  const client = makeMockClient({ [tool]: makeDynamicTool(vi.fn().mockResolvedValue(result)) });
  mockCreateMCPClient.mockImplementation(async () => client);
  vi.spyOn(manager, 'loadConfig').mockReturnValue({
    mcpServers: { [server]: { url: `http://${server}` } },
  });
  await manager.connect();
}

describe('MCPManager.unshapedTools — the watcher probe surface (#572)', () => {
  let manager: MCPManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MCPManager();
  });

  /** A chat page: many small objects, each with an id — the `appeared` shape. */
  function messagePage(n: number): unknown {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            items: Array.from({ length: n }, (_, i) => ({
              id: `m${i}`,
              isSender: false,
              text: 'x'.repeat(500),
            })),
          }),
        },
      ],
    };
  }

  const connectWithPage = (n: number) =>
    connectOneReturning(manager, 'beeper', 'list_messages', messagePage(n));

  function idsIn(result: unknown): string[] {
    const text = (result as { content: { text: string }[] }).content[0].text;
    return (JSON.parse(text) as { items: { id: string }[] }).items
      .filter((it) => typeof it?.id === 'string')
      .map((it) => it.id);
  }

  it('keeps every id, where the shaped bag saturates the set', async () => {
    // PAIRED, and that is what makes it non-vacuous: the first half proves
    // shaping really does cut this payload, so the second half cannot pass
    // because shaping quietly became a no-op.
    await connectWithPage(60);
    const key = mcpToolName('beeper', 'list_messages');

    const shaped = await manager.snapshot({ mode: 'cap', maxChars: 8000 }).tools[key].execute({});
    // `capArray` drops from the BACK, so the id set saturates around a dozen
    // however large the page is — 20 items yields 12, 100 items yields 12.
    expect(idsIn(shaped).length).toBeLessThan(20);

    const unshaped = await (
      manager.unshapedTools()[key] as { execute: (a: unknown) => Promise<unknown> }
    ).execute({});
    expect(idsIn(unshaped)).toHaveLength(60);
  });

  it('is the bag `snapshot()` derives, not a second assembler', async () => {
    // `snapshot()` is the single assembler (#305) and an accessor that rebuilt
    // the flat bag itself is how the two drift — a key present in one and
    // missing from the other is the #305 failure, one door over.
    //
    // Key sets, not object identity: every call REBUILDS the registry (that is
    // the "never a cached bag" rule), so even two `snapshot()` calls hand back
    // different objects.
    await connectWithPage(2);
    expect(Object.keys(manager.unshapedTools()).sort()).toEqual(
      Object.keys(manager.snapshot().tools).sort(),
    );
    expect(Object.keys(manager.unshapedTools())).toContain(mcpToolName('beeper', 'list_messages'));
  });
});
