import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A dead MCP server must not be able to hold a turn (#594).
 *
 * The incident: `send_message` against a proxy whose upstream had gone away. The
 * proxy logged `ECONNREFUSED` to stderr and never wrote a JSON-RPC error back
 * down stdio, so the request id stayed open. Bernard's `await` had no clock and
 * no signal, so the turn ran 35 minutes, ended only on Esc, and the call finally
 * errored 63 minutes after it started — 28 of them after the turn was over.
 * Nothing was sent, and the reconnect wrapper then retried the send twice.
 *
 * Separate file from `mcp.test.ts` because these need fake timers, and that file
 * has 39 tests that do not.
 */
vi.mock('@ai-sdk/mcp', () => ({ createMCPClient: vi.fn() }));
vi.mock('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: vi.fn(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock('./output.js', () => ({ printInfo: vi.fn(), printError: vi.fn() }));
vi.mock('ai', () => ({ jsonSchema: (schema: unknown) => ({ _jsonSchema: schema }) }));
vi.mock('./logger.js', async () => {
  const actual = await vi.importActual<typeof import('./logger.js')>('./logger.js');
  return { ...actual, debugLog: vi.fn() };
});

const { createMCPClient } = await import('@ai-sdk/mcp');
const { debugLog } = await import('./logger.js');
const { MCPManager } = await import('./mcp.js');
const { mcpToolName } = await import('./mcp-names.js');

const mockCreateMCPClient = createMCPClient as ReturnType<typeof vi.fn>;

function makeMockClient(toolsMap: Record<string, unknown>) {
  return {
    tools: vi.fn().mockResolvedValue(toolsMap),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDynamicTool(executeFn: (...args: never[]) => unknown) {
  return {
    type: 'dynamic',
    inputSchema: { jsonSchema: { type: 'object', properties: {} } },
    description: 'test tool',
    execute: executeFn,
  };
}

describe('a per-call budget (#594)', () => {
  let manager: InstanceType<typeof MCPManager>;
  const originalBudget = process.env.BERNARD_MCP_CALL_TIMEOUT_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MCPManager();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalBudget === undefined) delete process.env.BERNARD_MCP_CALL_TIMEOUT_MS;
    else process.env.BERNARD_MCP_CALL_TIMEOUT_MS = originalBudget;
  });

  async function connect(tools: Record<string, unknown>) {
    mockCreateMCPClient.mockResolvedValue(makeMockClient(tools));
    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: { beeper: { url: 'http://beeper' } },
    });
    await manager.connect();
    return manager.getTools();
  }

  it('abandons a call that never answers, naming the tool and the server', async () => {
    process.env.BERNARD_MCP_CALL_TIMEOUT_MS = '50';
    // The incident shape exactly: a promise that never settles, because the
    // proxy wrote the failure to stderr instead of to stdio.
    const tools = await connect({ send_message: makeDynamicTool(() => new Promise(() => {})) });

    await expect(
      tools[mcpToolName('beeper', 'send_message')].execute({ chatID: '244' }),
    ).rejects.toThrow(/MCP tool "send_message" on server "beeper" timed out after 50ms/);
  });

  it('says the outcome is unknown rather than claiming nothing happened', async () => {
    // A send that timed out may well have landed. Saying so is what stops the
    // model confidently re-sending, which is the expensive half of this bug.
    process.env.BERNARD_MCP_CALL_TIMEOUT_MS = '20';
    const tools = await connect({ send_message: makeDynamicTool(() => new Promise(() => {})) });

    await expect(tools[mcpToolName('beeper', 'send_message')].execute({})).rejects.toThrow(
      /may or may not have taken effect/,
    );
  });

  it('lets a call that answers in time through untouched', async () => {
    process.env.BERNARD_MCP_CALL_TIMEOUT_MS = '5000';
    const tools = await connect({ get_messages: makeDynamicTool(async () => 'ok') });

    expect(await tools[mcpToolName('beeper', 'get_messages')].execute({})).toBe('ok');
  });

  it('is disabled by an explicit 0, and only by that', async () => {
    // `0` has to DISABLE rather than fall back: a user with a legitimately
    // minutes-long tool needs an off switch, and "fall back to 60 s" is not one.
    // A typo still falls back, which is the other half of the rule.
    process.env.BERNARD_MCP_CALL_TIMEOUT_MS = '0';
    vi.useFakeTimers();
    const tools = await connect({ slow: makeDynamicTool(() => new Promise(() => {})) });

    let settled = false;
    void tools[mcpToolName('beeper', 'slow')].execute({}).then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).toBe(false);
  });
});

describe('the abort signal reaches the call (#594)', () => {
  let manager: InstanceType<typeof MCPManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MCPManager();
  });

  async function connect(tools: Record<string, unknown>) {
    mockCreateMCPClient.mockResolvedValue(makeMockClient(tools));
    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: { beeper: { url: 'http://beeper' } },
    });
    await manager.connect();
    return manager.getTools();
  }

  it('forwards `ToolExecutionOptions` to the SDK', async () => {
    // `augment.ts` has always passed it in; this wrapper's signature took one
    // parameter and dropped it on the floor.
    const executeFn = vi.fn().mockResolvedValue('ok');
    const tools = await connect({ get_messages: makeDynamicTool(executeFn) });
    const ac = new AbortController();

    await tools[mcpToolName('beeper', 'get_messages')].execute(
      { a: 1 },
      { abortSignal: ac.signal },
    );

    expect(executeFn.mock.calls[0][1]).toMatchObject({ abortSignal: ac.signal });
  });

  it('ends the await when the caller aborts, even though the SDK cannot', async () => {
    // The load-bearing half, and the reason forwarding alone is not the fix.
    // `MCPClient.request` registers no abort listener: it calls
    // `throwIfAborted()` once at entry and then checks `signal.aborted` only
    // when a response ARRIVES. For a server that never answers, the promise it
    // returns stays pending forever however the signal is set — which is
    // modelled here by an execute that ignores the signal completely.
    const tools = await connect({ send_message: makeDynamicTool(() => new Promise(() => {})) });
    const ac = new AbortController();

    const p = tools[mcpToolName('beeper', 'send_message')].execute({}, { abortSignal: ac.signal });
    ac.abort();

    await expect(p).rejects.toThrow(/was cancelled/);
  });

  it('refuses a call whose signal is already aborted, before touching the server', async () => {
    const executeFn = vi.fn().mockResolvedValue('ok');
    const tools = await connect({ send_message: makeDynamicTool(executeFn) });
    const ac = new AbortController();
    ac.abort();

    await expect(
      tools[mcpToolName('beeper', 'send_message')].execute({}, { abortSignal: ac.signal }),
    ).rejects.toThrow(/was cancelled/);
    expect(executeFn).not.toHaveBeenCalled();
  });
});

describe('the reconnect retry is gated (#594)', () => {
  let manager: InstanceType<typeof MCPManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MCPManager();
  });

  afterEach(() => {
    delete process.env.BERNARD_MCP_CALL_TIMEOUT_MS;
  });

  async function connect(tools: Record<string, unknown>) {
    mockCreateMCPClient.mockResolvedValue(makeMockClient(tools));
    vi.spyOn(manager, 'loadConfig').mockReturnValue({
      mcpServers: { beeper: { url: 'http://beeper' } },
    });
    await manager.connect();
    return manager.getTools();
  }

  it('never re-issues a tool that emits', async () => {
    // The bonus hazard in the same trace: when the connection finally closed the
    // wrapper fired the retry for `send_message`, twice. It happened to fail. A
    // send that timed out and actually LANDED would be sent again.
    //
    // `duplicate-guard.ts` cannot cover this either: that gate records
    // SUCCEEDED calls, and the first attempt here never succeeded.
    const failExecute = vi.fn().mockRejectedValue(new Error('Connection closed'));
    const tools = await connect({ send_message: makeDynamicTool(failExecute) });

    const retryExecute = vi.fn().mockResolvedValue('sent');
    mockCreateMCPClient.mockResolvedValue(
      makeMockClient({ send_message: makeDynamicTool(retryExecute) }),
    );

    await expect(tools[mcpToolName('beeper', 'send_message')].execute({})).rejects.toThrow(
      'Connection closed',
    );
    expect(failExecute).toHaveBeenCalledTimes(1);
    expect(retryExecute).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith('mcp:tool-retry-refused', {
      tool: 'send_message',
      server: 'beeper',
      cause: 'non-idempotent',
    });
  });

  it('still reconnects and retries an idempotent tool', async () => {
    // Guards the guard: a gate keyed on the wrong predicate would disable the
    // reconnect entirely, turning every transient disconnect into a hard error.
    const failExecute = vi.fn().mockRejectedValue(new Error('SSE stream disconnected'));
    const tools = await connect({ get_messages: makeDynamicTool(failExecute) });

    const retryExecute = vi.fn().mockResolvedValue('recovered');
    mockCreateMCPClient.mockResolvedValue(
      makeMockClient({ get_messages: makeDynamicTool(retryExecute) }),
    );

    expect(await tools[mcpToolName('beeper', 'get_messages')].execute({})).toBe('recovered');
    expect(retryExecute).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect after our own deadline', async () => {
    // Waiting again is not a remedy for having waited too long, and it doubles
    // the ceiling the budget exists to impose.
    process.env.BERNARD_MCP_CALL_TIMEOUT_MS = '20';
    const tools = await connect({ get_messages: makeDynamicTool(() => new Promise(() => {})) });
    const reconnect = vi.spyOn(manager, 'reconnectServer');

    await expect(tools[mcpToolName('beeper', 'get_messages')].execute({})).rejects.toThrow(
      /timed out/,
    );
    expect(reconnect).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith('mcp:tool-retry-refused', {
      tool: 'get_messages',
      server: 'beeper',
      cause: 'timeout',
    });
  });

  it('does not reconnect after the user cancels', async () => {
    // Re-issuing a call the user just stopped — and reconnecting the server to
    // do it — is the opposite of what Esc means.
    const tools = await connect({ get_messages: makeDynamicTool(() => new Promise(() => {})) });
    const reconnect = vi.spyOn(manager, 'reconnectServer');
    const ac = new AbortController();

    const p = tools[mcpToolName('beeper', 'get_messages')].execute({}, { abortSignal: ac.signal });
    ac.abort();

    await expect(p).rejects.toThrow(/was cancelled/);
    expect(reconnect).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith('mcp:tool-retry-refused', {
      tool: 'get_messages',
      server: 'beeper',
      cause: 'cancelled',
    });
  });
});
