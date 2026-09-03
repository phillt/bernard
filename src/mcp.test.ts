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

  it('tool call succeeds normally without reconnection', async () => {
    const executeFn = vi.fn().mockResolvedValue('success');
    await setupWithServer('test-server', { myTool: makeDynamicTool(executeFn) });

    const tools = manager.getTools();
    const result = await tools[mcpToolName('test-server', 'myTool')].execute({ query: 'hello' });

    expect(result).toBe('success');
    expect(executeFn).toHaveBeenCalledWith({ query: 'hello' });
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
    expect(mockPrintInfo).toHaveBeenCalledWith(
      'MCP tool "myTool" failed, reconnecting to "test-server"...',
    );
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

  // Risk is classified from the RAW name, not the key — the prefix is
  // transparent to the end-anchored check today, but an R2-truncated key's tail
  // is the tool's tail, not its verb.
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

  /** Connects one server whose single tool returns `result`. */
  async function connectReturning(result: unknown): Promise<Record<string, any>> {
    const client = makeMockClient({
      get_email: makeDynamicTool(vi.fn().mockResolvedValue(result)),
    });
    mockCreateMCPClient.mockImplementation(async () => client);
    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: { gmail: { url: 'http://gmail' } },
    });
    await manager.connect();
    return manager.getServerTools({ mode: 'cap', maxChars: 800 });
  }

  function cappedLines() {
    return vi.mocked(debugLog).mock.calls.filter(([label]) => label === 'mcp:result:capped');
  }

  it('names the server and the tool whose result was cut', async () => {
    const perServer = await connectReturning({
      content: [{ type: 'text', text: JSON.stringify({ body: 'x'.repeat(20_000) }) }],
    });
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
    const perServer = await connectReturning({ content: [{ type: 'text', text: '{"ok":true}' }] });
    await perServer.gmail[mcpToolName('gmail', 'get_email')].execute({});

    // A pass-through is not a decision worth a line, and it is the overwhelming
    // majority of calls.
    expect(cappedLines()).toHaveLength(0);
  });
});
