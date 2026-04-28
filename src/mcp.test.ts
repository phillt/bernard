import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external dependencies before importing MCPManager
vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(),
}));

vi.mock('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: vi.fn(),
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
const { MCPManager, normalizeSchemaForOpenAI, validateOpenAIStrictSchema } = await import('./mcp.js');

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

describe('normalizeSchemaForOpenAI', () => {
  it('sets additionalProperties:false on object schemas without properties', () => {
    const out = normalizeSchemaForOpenAI({ type: 'object' });
    expect(out.additionalProperties).toBe(false);
  });

  it('overrides additionalProperties:<schema> with false', () => {
    const out = normalizeSchemaForOpenAI({
      type: 'object',
      additionalProperties: { type: 'string' },
    });
    expect(out.additionalProperties).toBe(false);
  });

  it('sets additionalProperties:false on every object inside items.anyOf (gmail attachments shape)', () => {
    // Mirrors the google_gmail_send_email schema that previously failed strict mode at
    // properties.attachments.anyOf[0].items.anyOf[0]
    const schema = {
      type: 'object',
      properties: {
        attachments: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
              { type: 'object' },
            ],
          },
        },
      },
      required: [],
    };

    const out = normalizeSchemaForOpenAI(schema);

    // attachments was optional → wrapped as anyOf:[orig, {type:'null'}]
    const attachmentsSchema = out.properties.attachments;
    expect(attachmentsSchema.anyOf).toBeDefined();
    const arraySchema = attachmentsSchema.anyOf[0];
    expect(arraySchema.type).toBe('array');

    const itemAlternatives = arraySchema.items.anyOf;
    expect(itemAlternatives).toHaveLength(2);
    for (const alt of itemAlternatives) {
      expect(alt.additionalProperties).toBe(false);
    }
  });

  it('marks every property as required and wraps optional ones as nullable', () => {
    const out = normalizeSchemaForOpenAI({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
      },
      required: ['a'],
    });

    expect(out.required).toEqual(expect.arrayContaining(['a', 'b']));
    expect(out.properties.a).toEqual({ type: 'string' });
    expect(out.properties.b.anyOf).toEqual([{ type: 'number' }, { type: 'null' }]);
    expect(out.additionalProperties).toBe(false);
  });

  it('strips forbidden keywords and merges oneOf into anyOf', () => {
    const out = normalizeSchemaForOpenAI({
      oneOf: [{ type: 'string' }, { type: 'number' }],
      not: { type: 'boolean' },
      patternProperties: { '^x': { type: 'string' } },
    });
    expect(out.oneOf).toBeUndefined();
    expect(out.not).toBeUndefined();
    expect(out.patternProperties).toBeUndefined();
    expect(out.anyOf).toEqual([{ type: 'string' }, { type: 'number' }]);
  });

  it('recurses into $defs', () => {
    const out = normalizeSchemaForOpenAI({
      $defs: {
        Attachment: { type: 'object' },
      },
    });
    expect(out.$defs.Attachment.additionalProperties).toBe(false);
  });

  it('produces strict-mode-compliant output for the gmail attachments shape', () => {
    const schema = {
      type: 'object',
      properties: {
        to: { type: 'string' },
        attachments: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'object', properties: { filename: { type: 'string' } } },
              { type: 'object' },
            ],
          },
        },
      },
      required: ['to'],
    };
    const out = normalizeSchemaForOpenAI(schema);
    // Validator should not throw — exercises the same walk OpenAI's strict mode performs.
    expect(() => validateOpenAIStrictSchema(out)).not.toThrow();
  });
});

describe('validateOpenAIStrictSchema', () => {
  it('passes a fully-normalized object schema', () => {
    const ok = {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
      additionalProperties: false,
    };
    expect(() => validateOpenAIStrictSchema(ok)).not.toThrow();
  });

  it('throws when an object is missing additionalProperties:false', () => {
    expect(() =>
      validateOpenAIStrictSchema({ type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }),
    ).toThrow(/additionalProperties must be false/);
  });

  it('throws with the exact JSON path of the offending sub-schema', () => {
    const bad = {
      type: 'object',
      additionalProperties: false,
      required: ['attachments'],
      properties: {
        attachments: {
          anyOf: [
            {
              type: 'array',
              items: {
                anyOf: [
                  { type: 'object', properties: {}, required: [] },
                ],
              },
            },
            { type: 'null' },
          ],
        },
      },
    };
    expect(() => validateOpenAIStrictSchema(bad)).toThrow(
      /properties\.attachments\.anyOf\.0\.items\.anyOf\.0/,
    );
  });

  it('throws on forbidden keywords', () => {
    expect(() => validateOpenAIStrictSchema({ oneOf: [{ type: 'string' }] })).toThrow(/forbidden/);
    expect(() => validateOpenAIStrictSchema({ patternProperties: {} })).toThrow(/forbidden/);
  });

  it('throws when a property is not in required', () => {
    expect(() =>
      validateOpenAIStrictSchema({
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a'],
      }),
    ).toThrow(/property "b" must be in required/);
  });

  it('treats boolean schema shortcuts as valid', () => {
    expect(() => validateOpenAIStrictSchema(true)).not.toThrow();
    expect(() => validateOpenAIStrictSchema(false)).not.toThrow();
  });
});
