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

const { createMCPClient } = await import('@ai-sdk/mcp');
const { printInfo, printError } = await import('./output.js');
const { MCPManager, verifyMCPServer } = await import('./mcp.js');
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
    const result = await tools.myTool.execute({ query: 'hello' });

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

    const result = await tools.myTool.execute({ query: 'retry' });

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

    await expect(tools.myTool.execute({ query: 'fail' })).rejects.toThrow(
      'SSE stream disconnected',
    );
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

    await expect(tools.myTool.execute({ query: 'fail' })).rejects.toThrow('retry also failed');
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
    expect(tools.toolA).toBeDefined();
    expect(tools.toolB).toBeDefined();

    // Both work normally
    expect(await tools.toolA.execute({})).toBe('r1');
    expect(await tools.toolB.execute({})).toBe('r2');
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
    expect(out.richTool.parameters).toEqual({ _jsonSchema: richSchema });
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
    expect(manager.getTools().goodTool).toBeDefined();
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
