import * as fs from 'node:fs';
import * as path from 'node:path';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { jsonSchema } from 'ai';
import { printInfo, printError } from './output.js';
import { MCP_CONFIG_PATH as CONFIG_PATH } from './paths.js';
import { attachMeta } from './framework/tools/adapter.js';
import { isReadOnlyMCPSuffix } from './risk.js';
import type { ToolMeta } from './framework/tools/types.js';
import { normalizeToolResult } from './text.js';
import { shapeMCPResult, type MCPResultShapingConfig } from './mcp-result-shaper.js';
import type { AgentContextMCP } from './framework/context.js';

/** Configuration for an MCP server launched via stdio subprocess. */
interface MCPStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Configuration for an MCP server accessed over a network URL (SSE or HTTP). */
interface MCPUrlConfig {
  url: string;
  type?: 'sse' | 'http';
  headers?: Record<string, string>;
}

/** Discriminated union of stdio and URL-based MCP server configurations. */
type MCPServerConfig = MCPStdioConfig | MCPUrlConfig;

/** Top-level shape of the MCP configuration file. */
interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

/** Runtime connection status for a single MCP server. */
interface ServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Read at call time (not module load) so tests can stub the env var. Only a
 * positive integer is honored — a zero, negative, or non-numeric value (which
 * would make `setTimeout` fire immediately and spuriously time out every
 * server) falls back to the default.
 */
function mcpConnectTimeoutMs(): number {
  const parsed = parseInt(process.env.BERNARD_MCP_CONNECT_TIMEOUT_MS || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MCP_CONNECT_TIMEOUT_MS;
}

/** Sentinel rejection used to distinguish a connect/listing timeout from a real error. */
class MCPHandshakeTimeout extends Error {}

function handshakeTimeoutMessage(timeoutMs: number): string {
  return `Timed out after ${timeoutMs}ms — the server didn't connect and list its tools in time. Common causes: it's an HTTP/SSE server started as a stdio command (configure it as a "url" server instead), or a stdio flag such as "--stdio" is missing.`;
}

/**
 * Starts connecting to an MCP server without awaiting the handshake.
 *
 * The stdio transport is constructed synchronously and returned alongside the
 * (still-pending) client promise so callers can race the connect against a
 * timeout and still tear down the spawned child process when `createMCPClient`
 * never resolves — the client promise can't be closed because it never
 * settled, but `transport.close()` kills the child via its AbortController.
 */
function startConnect(serverConfig: MCPServerConfig): {
  clientPromise: Promise<MCPClient>;
  transport?: Experimental_StdioMCPTransport;
} {
  if ('url' in serverConfig) {
    return {
      clientPromise: createMCPClient({
        transport: {
          type: serverConfig.type ?? 'sse',
          url: serverConfig.url,
          headers: serverConfig.headers,
        },
      }),
    };
  }
  const transport = new Experimental_StdioMCPTransport({
    command: serverConfig.command,
    args: serverConfig.args,
    env: serverConfig.env
      ? { ...(process.env as Record<string, string>), ...serverConfig.env }
      : undefined,
  });
  return { clientPromise: createMCPClient({ transport }), transport };
}

/**
 * Manages the lifecycle of MCP (Model Context Protocol) server connections.
 *
 * Reads server definitions from the MCP config file, establishes connections
 * (stdio or URL-based), aggregates tools from all servers, and handles
 * automatic reconnection with retry when a tool call fails.
 */
export class MCPManager {
  private clients: Map<string, MCPClient> = new Map();
  private serverStatuses: ServerStatus[] = [];
  private tools: Record<string, any> = {};
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private toolServerMap: Map<string, string> = new Map();
  // Per-server reconnection lock to coalesce concurrent reconnect attempts
  private reconnectPromises: Map<string, Promise<boolean>> = new Map();

  /**
   * Reads and parses the MCP configuration file.
   * @returns The parsed config, or an empty config if the file does not exist.
   * @throws {Error} If the file exists but contains invalid JSON.
   */
  loadConfig(): MCPConfig {
    if (!fs.existsSync(CONFIG_PATH)) {
      return { mcpServers: {} };
    }

    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    try {
      return JSON.parse(raw) as MCPConfig;
    } catch {
      throw new Error(`Invalid JSON in ${CONFIG_PATH}`);
    }
  }

  /**
   * Creates an MCP client for the given server configuration and lists its
   * tools, racing both against `BERNARD_MCP_CONNECT_TIMEOUT_MS` (default 15s).
   *
   * A server that never completes the MCP handshake (e.g. an HTTP/SSE server
   * misconfigured as stdio) would otherwise leave `createMCPClient` pending
   * forever and block `connect()` — and with it the whole REPL (#254). The
   * stdio transport is held separately from the client so a timeout can still
   * tear down the spawned child process (the transport owns it via an
   * AbortController); the client never resolved, so it can't be closed.
   * @internal
   */
  private async connectAndListWithTimeout(
    serverConfig: MCPServerConfig,
  ): Promise<{ client: MCPClient; serverTools: Record<string, any> }> {
    const timeoutMs = mcpConnectTimeoutMs();
    const { clientPromise, transport } = startConnect(serverConfig);
    let client: MCPClient | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const probe = (async () => {
        client = await clientPromise;
        const serverTools = await client.tools();
        return { client, serverTools };
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MCPHandshakeTimeout()), timeoutMs);
      });
      return await Promise.race([probe, timeout]);
    } catch (err) {
      try {
        if (client) await client.close();
        else if (transport) await transport.close();
      } catch {
        /* best-effort cleanup */
      }
      throw err instanceof MCPHandshakeTimeout
        ? new Error(handshakeTimeoutMessage(timeoutMs))
        : err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Connects to all MCP servers defined in the config file.
   *
   * Connections are established concurrently via `Promise.allSettled`.
   * Servers that fail to connect are recorded with an error status and
   * logged, but do not prevent other servers from connecting.
   */
  async connect(): Promise<void> {
    let config: MCPConfig;
    try {
      config = this.loadConfig();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(`MCP config error: ${message}`);
      return;
    }

    const serverEntries = Object.entries(config.mcpServers);
    if (serverEntries.length === 0) return;

    const results = await Promise.allSettled(
      serverEntries.map(async ([name, serverConfig]) => {
        this.serverConfigs.set(name, serverConfig);
        const { client, serverTools } = await this.connectAndListWithTimeout(serverConfig);
        return { name, client, serverTools };
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const name = serverEntries[i][0];

      if (result.status === 'fulfilled') {
        const { client, serverTools } = result.value;
        this.clients.set(name, client);

        const toolNames = Object.keys(serverTools);

        for (const toolName of toolNames) {
          if (this.tools[toolName]) {
            printInfo(`  Warning: MCP tool "${toolName}" from "${name}" overrides existing tool`);
          }
          this.tools[toolName] = serverTools[toolName];
          this.toolServerMap.set(toolName, name);
        }

        this.serverStatuses.push({
          name,
          connected: true,
          toolCount: toolNames.length,
        });
      } else {
        const message =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.serverStatuses.push({
          name,
          connected: false,
          toolCount: 0,
          error: message,
        });
        printError(`MCP server "${name}" failed to connect: ${message}`);
      }
    }
  }

  /**
   * Reconnects a single MCP server by name, closing the old client first.
   *
   * Concurrent calls for the same server are coalesced so only one
   * reconnection attempt runs at a time.
   * @param name - The server key as defined in the config file.
   * @returns `true` if the reconnection succeeded, `false` otherwise.
   */
  async reconnectServer(name: string): Promise<boolean> {
    // Coalesce concurrent reconnect attempts for the same server —
    // if a reconnect is already in progress, return its promise instead
    // of starting a second one (which would close the first's new client).
    const existing = this.reconnectPromises.get(name);
    if (existing) return existing;

    const promise = this.doReconnectServer(name);
    this.reconnectPromises.set(name, promise);
    try {
      return await promise;
    } finally {
      this.reconnectPromises.delete(name);
    }
  }

  /**
   * Performs the actual reconnection logic for a single server.
   * @internal
   */
  private async doReconnectServer(name: string): Promise<boolean> {
    const config = this.serverConfigs.get(name);
    if (!config) return false;

    // Close the existing client
    const existingClient = this.clients.get(name);
    if (existingClient) {
      try {
        await existingClient.close();
      } catch {
        /* ignore */
      }
      this.clients.delete(name);
    }

    try {
      const { client, serverTools } = await this.connectAndListWithTimeout(config);
      this.clients.set(name, client);

      const toolNames = Object.keys(serverTools);

      // Remove old tools from this server.
      // Deleting Map entries during iteration is safe per the JS Map spec.
      for (const [toolName, serverName] of this.toolServerMap.entries()) {
        if (serverName === name) {
          delete this.tools[toolName];
          this.toolServerMap.delete(toolName);
        }
      }

      // Register fresh tools
      for (const toolName of toolNames) {
        this.tools[toolName] = serverTools[toolName];
        this.toolServerMap.set(toolName, name);
      }

      // Update server status
      const statusIndex = this.serverStatuses.findIndex((s) => s.name === name);
      const newStatus: ServerStatus = { name, connected: true, toolCount: toolNames.length };
      if (statusIndex >= 0) {
        this.serverStatuses[statusIndex] = newStatus;
      } else {
        this.serverStatuses.push(newStatus);
      }

      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(`MCP reconnection to "${name}" failed: ${message}`);

      const statusIndex = this.serverStatuses.findIndex((s) => s.name === name);
      const newStatus: ServerStatus = { name, connected: false, toolCount: 0, error: message };
      if (statusIndex >= 0) {
        this.serverStatuses[statusIndex] = newStatus;
      } else {
        this.serverStatuses.push(newStatus);
      }

      return false;
    }
  }

  /**
   * Converts a dynamic MCP tool to the function-tool shape expected by AI SDK v4.
   * @internal
   */
  private convertTool(_name: string, tool: any): any {
    if (tool.type === 'dynamic') {
      const { type: _type, inputSchema, ...rest } = tool;
      return {
        ...rest,
        parameters: jsonSchema(inputSchema.jsonSchema),
      };
    }
    return tool;
  }

  /**
   * Returns all MCP tools, converted for AI SDK v4 compatibility.
   *
   * Each tool's `execute` method is wrapped with automatic reconnect-and-retry:
   * if a call fails, the owning server is reconnected and the call retried once.
   */
  getTools(shaping?: MCPResultShapingConfig): Record<string, any> {
    // Structure-aware result shaping (#297): bound over-budget MCP results
    // before they enter an agent's context so a large list/body doesn't re-bill
    // on every subsequent step. `off` (or unset) is a pass-through.
    const shape = (result: unknown): unknown =>
      shaping ? shapeMCPResult(result, shaping) : result;
    // Convert dynamic MCP tools to function tools compatible with AI SDK v4.
    // @ai-sdk/mcp@1.x returns tools with type:'dynamic' and inputSchema from
    // @ai-sdk/provider-utils@4.x, but ai@4.x expects type:undefined and
    // parameters wrapped with @ai-sdk/ui-utils's jsonSchema (which includes
    // the validatorSymbol needed for argument validation).
    const converted: Record<string, any> = {};
    for (const [name, tool] of Object.entries(this.tools)) {
      const baseTool = this.convertTool(name, tool);
      const originalExecute = baseTool.execute;
      const serverName = this.toolServerMap.get(name);

      const wrapped = {
        ...baseTool,
        // Retry wrapper: on failure, reconnect the server and retry once.
        // If the retry also fails, the *retry* error is thrown (not the original)
        // so the caller sees the most recent failure reason.
        execute: async (args: unknown) => {
          try {
            const result = await originalExecute(args);
            return shape(normalizeToolResult(result));
          } catch (error) {
            if (serverName) {
              printInfo(`MCP tool "${name}" failed, reconnecting to "${serverName}"...`);
              const reconnected = await this.reconnectServer(serverName);
              if (reconnected && this.tools[name]) {
                const freshTool = this.convertTool(name, this.tools[name]);
                const retryResult = await freshTool.execute(args);
                return shape(normalizeToolResult(retryResult));
              }
            }
            throw error;
          }
        },
      };

      // Risk-based confirmation gate (#144): tag every MCP tool with metadata
      // so the augment layer can route it through `confirmAction` at the right
      // threshold. Names ending in a read-only verb → `kind: 'read'` (low risk,
      // never prompts). Everything else → `kind: 'write'` with `sideEffect:
      // 'local'` (medium risk, prompts only in `strict` mode). Users can
      // promote a tool to high via a future `mcp.json` override (out of scope).
      const isRead = isReadOnlyMCPSuffix(name);
      const meta: ToolMeta = {
        name,
        kind: isRead ? 'read' : 'write',
        category: serverName ? `mcp.${serverName}` : 'mcp',
        deterministic: false,
        sideEffect: isRead ? 'network' : 'local',
      };
      converted[name] = attachMeta(wrapped, meta);
    }
    return converted;
  }

  /** Returns the current connection status for every configured server. */
  getServerStatuses(): ServerStatus[] {
    return this.serverStatuses;
  }

  /** Returns the names of all servers that are currently connected. */
  getConnectedServerNames(): string[] {
    return this.serverStatuses.filter((s) => s.connected).map((s) => s.name);
  }

  /**
   * Returns a `{ server: [toolName, …] }` map over every connected server (an
   * inversion of `toolServerMap`) — the per-server view threaded into
   * `AgentContextMCP.serverTools` at bootstrap so per-server MCP delegation
   * (#296) can scope each helper sub-agent to that server's real tools while the
   * main agent carries only one `delegate_<server>` tool.
   */
  getServerToolMap(): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const [toolName, serverName] of this.toolServerMap.entries()) {
      (map[serverName] ??= []).push(toolName);
    }
    return map;
  }

  /**
   * The complete {@link AgentContextMCP} for this manager, in one call.
   *
   * Exists because assembling it field-by-field is a standing trap: every
   * origin has to remember all three accessors, and a half-populated literal
   * type-checks. The cron runner shipped with `tools` + `serverNames` but no
   * `serverTools`, which silently reduced every `delegate_<server>` to zero
   * tools (#305). One call makes that unrepresentable.
   */
  snapshot(shaping?: MCPResultShapingConfig): AgentContextMCP {
    return {
      tools: this.getTools(shaping),
      serverNames: this.getConnectedServerNames(),
      serverTools: this.getServerToolMap(),
    };
  }

  /**
   * Reconciles a fresh {@link verifyMCPServer} probe against the tools actually
   * wired into THIS running session. A probe spawns the server in isolation, so
   * it always reports the server's own health — but that says nothing about
   * whether the running agent can call those tools. A tool is:
   *   - `live`     — currently routed to this server (callable now),
   *   - `shadowed` — a *different* server exported the same name and won the
   *                  last-writer-wins race in {@link connect}, so calls route
   *                  elsewhere,
   *   - `missing`  — not in the live tool set at all (the server wasn't
   *                  connected when the session snapshotted its tools at
   *                  startup — a restart is needed to pick it up).
   * This is what turns a misleading "healthy, 23 tools" into an honest "healthy
   * in isolation but not actually loaded in this session."
   */
  getLiveRegistration(
    name: string,
    probeToolNames: string[],
  ): {
    connected: boolean;
    error?: string;
    live: string[];
    shadowed: { tool: string; owner: string }[];
    missing: string[];
  } {
    const status = this.serverStatuses.find((s) => s.name === name);
    const live: string[] = [];
    const shadowed: { tool: string; owner: string }[] = [];
    const missing: string[] = [];
    for (const t of probeToolNames) {
      const owner = this.toolServerMap.get(t);
      if (owner === name) live.push(t);
      else if (owner) shadowed.push({ tool: t, owner });
      else missing.push(t);
    }
    return { connected: status?.connected ?? false, error: status?.error, live, shadowed, missing };
  }

  /** Gracefully closes all active MCP client connections. */
  async close(): Promise<void> {
    const closePromises = Array.from(this.clients.values()).map((client) =>
      client.close().catch(() => {}),
    );
    await Promise.allSettled(closePromises);
    this.clients.clear();
  }
}

/**
 * The process's live MCPManager, registered by the bootstrap (REPL / cron) after
 * {@link MCPManager.connect}. Diagnostic tools like `mcp_verify` read it to
 * compare a fresh probe against the tools actually wired into the running
 * session. Per-process (the REPL and the cron daemon each register their own).
 */
let activeMCPManager: MCPManager | null = null;
export function setActiveMCPManager(manager: MCPManager | null): void {
  activeMCPManager = manager;
}
export function getActiveMCPManager(): MCPManager | null {
  return activeMCPManager;
}

/**
 * Lists all MCP servers in the config file with their connection details.
 * @returns An array of server summaries. Returns an empty array if no config file exists.
 * @throws {Error} If the config file contains invalid JSON.
 */
export function listMCPServers(): {
  key: string;
  command?: string;
  args?: string[];
  url?: string;
  type?: 'sse' | 'http';
}[] {
  if (!fs.existsSync(CONFIG_PATH)) {
    return [];
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  let config: MCPConfig;
  try {
    config = JSON.parse(raw) as MCPConfig;
  } catch {
    throw new Error(`Invalid JSON in ${CONFIG_PATH}`);
  }

  return Object.entries(config.mcpServers).map(([key, server]) => {
    if ('url' in server) {
      return { key, url: server.url, type: server.type };
    }
    return { key, command: server.command, args: server.args ?? [] };
  });
}

/**
 * Retrieves the configuration for a single MCP server by key.
 * @param key - The server key as defined in the config file.
 * @returns The server config, or `undefined` if the key or config file does not exist.
 * @throws {Error} If the config file contains invalid JSON.
 */
export function getMCPServer(key: string): MCPServerConfig | undefined {
  if (!fs.existsSync(CONFIG_PATH)) {
    return undefined;
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  let config: MCPConfig;
  try {
    config = JSON.parse(raw) as MCPConfig;
  } catch {
    throw new Error(`Invalid JSON in ${CONFIG_PATH}`);
  }

  return config.mcpServers[key];
}

/**
 * Adds a stdio-based MCP server entry to the MCP config file.
 * @param key - Unique, whitespace-free identifier for the server.
 * @param command - The command to spawn (e.g. `"npx"`).
 * @param args - Optional command-line arguments.
 * @param env - Optional extra environment variables merged with `process.env`.
 * @throws {Error} If the key is empty/contains whitespace, the command is empty,
 *         the key already exists, or the config file contains invalid JSON.
 */
export function addMCPServer(
  key: string,
  command: string,
  args?: string[],
  env?: Record<string, string>,
): void {
  if (!key || /\s/.test(key)) {
    throw new Error('Server key must be non-empty and contain no whitespace.');
  }
  if (!command) {
    throw new Error('Command must be non-empty.');
  }

  const configDir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  let config: MCPConfig = { mcpServers: {} };
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    try {
      config = JSON.parse(raw) as MCPConfig;
    } catch {
      throw new Error(`Invalid JSON in ${CONFIG_PATH}`);
    }
  }

  if (key in config.mcpServers) {
    throw new Error(`MCP server "${key}" already exists. Remove it first, then add again.`);
  }

  const entry: MCPServerConfig = { command };
  if (args && args.length > 0) entry.args = args;
  if (env && Object.keys(env).length > 0) entry.env = env;

  config.mcpServers[key] = entry;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Adds a URL-based (SSE or HTTP) MCP server entry to the MCP config file.
 * @param key - Unique, whitespace-free identifier for the server.
 * @param url - The server endpoint URL.
 * @param type - Transport type; defaults to `'sse'` at connection time.
 * @param headers - Optional HTTP headers sent with every request.
 * @throws {Error} If the key is empty/contains whitespace, the URL is empty,
 *         the key already exists, or the config file contains invalid JSON.
 */
export function addMCPUrlServer(
  key: string,
  url: string,
  type?: 'sse' | 'http',
  headers?: Record<string, string>,
): void {
  if (!key || /\s/.test(key)) {
    throw new Error('Server key must be non-empty and contain no whitespace.');
  }
  if (!url) {
    throw new Error('URL must be non-empty.');
  }

  const configDir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  let config: MCPConfig = { mcpServers: {} };
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    try {
      config = JSON.parse(raw) as MCPConfig;
    } catch {
      throw new Error(`Invalid JSON in ${CONFIG_PATH}`);
    }
  }

  if (key in config.mcpServers) {
    throw new Error(`MCP server "${key}" already exists. Remove it first, then add again.`);
  }

  const entry: MCPUrlConfig = { url };
  if (type) entry.type = type;
  if (headers && Object.keys(headers).length > 0) entry.headers = headers;

  config.mcpServers[key] = entry;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Removes an MCP server entry from the MCP config file.
 * @param key - The server key to remove.
 * @throws {Error} If the config file does not exist, contains invalid JSON, or the key is not found.
 */
export function removeMCPServer(key: string): void {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`No MCP config file found. No servers configured.`);
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  let config: MCPConfig;
  try {
    config = JSON.parse(raw) as MCPConfig;
  } catch {
    throw new Error(`Invalid JSON in ${CONFIG_PATH}`);
  }

  if (!(key in config.mcpServers)) {
    const validKeys = Object.keys(config.mcpServers);
    const hint =
      validKeys.length > 0 ? ` Valid keys: ${validKeys.join(', ')}` : ' No servers configured.';
    throw new Error(`MCP server "${key}" not found.${hint}`);
  }

  delete config.mcpServers[key];
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/** Outcome of a one-off MCP server connection probe. */
export interface MCPVerifyResult {
  ok: boolean;
  toolCount: number;
  /** First handful of tool names (for a human-readable confirmation). */
  toolNames: string[];
  durationMs: number;
  /** True when the probe hit the timeout (vs. an explicit connection error). */
  timedOut: boolean;
  error?: string;
}

/**
 * Test-connects a single MCP server **without** mutating the live MCPManager or
 * requiring a Bernard restart: it builds the same transport `connect()` uses,
 * races the connect + `tools()` listing against `timeoutMs`, then closes the
 * client. Use it to confirm a freshly added/edited server actually speaks the
 * protocol and surfaces tools.
 *
 * A timeout almost always means the process started but never completed the MCP
 * handshake — typically an HTTP/SSE server launched as stdio, or a stdio flag
 * (e.g. `--stdio`) missing. In that case `createMCPClient` never resolves, so
 * there's no client to `close()`; we hold the stdio transport reference and
 * close it directly in `finally` to terminate the spawned child (it owns the
 * process via an AbortController) rather than leaking it until Bernard exits.
 */
export async function verifyMCPServer(
  config: MCPServerConfig,
  opts: { timeoutMs?: number } = {},
): Promise<MCPVerifyResult> {
  const timeoutMs = opts.timeoutMs ?? mcpConnectTimeoutMs();
  const startedAt = Date.now();
  const { clientPromise, transport } = startConnect(config);
  let client: MCPClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = (async () => {
      client = await clientPromise;
      return Object.keys(await client.tools());
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MCPHandshakeTimeout()), timeoutMs);
    });
    const names = await Promise.race([probe, timeout]);
    return {
      ok: true,
      toolCount: names.length,
      toolNames: names.slice(0, 20),
      durationMs: Date.now() - startedAt,
      timedOut: false,
    };
  } catch (err) {
    const timedOut = err instanceof MCPHandshakeTimeout;
    return {
      ok: false,
      toolCount: 0,
      toolNames: [],
      durationMs: Date.now() - startedAt,
      timedOut,
      error: timedOut
        ? handshakeTimeoutMessage(timeoutMs)
        : err instanceof Error
          ? err.message
          : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
    // Prefer closing via the client (closes its transport too); on a timeout
    // the client never resolved, so close the held stdio transport directly to
    // kill the spawned child.
    try {
      if (client) await client.close();
      else if (transport) await transport.close();
    } catch {
      /* best-effort cleanup */
    }
  }
}
