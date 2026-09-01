import * as fs from 'node:fs';
import * as path from 'node:path';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { jsonSchema } from 'ai';
import { printInfo, printError } from './output.js';
import { MCP_CONFIG_PATH as CONFIG_PATH } from './paths.js';
import { openSessionSidecarFd } from './logger.js';
import {
  flattenServerTools,
  makeAliasResolver,
  mcpServerSegment,
  mcpToolName,
} from './mcp-names.js';
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

/**
 * Where a spawned MCP server's stderr goes. Never `'inherit'`, which is what
 * {@link Experimental_StdioMCPTransport} defaults to: an MCP server is a
 * third-party process writing to a stream that has no Bernard surface — its
 * connection failures are already reported through `serverStatuses` and
 * `mcp_verify` — so inheriting only lets it scribble over the Ink frame.
 *
 * Never `'pipe'` either, and that one would be the worse bug: the transport
 * keeps its child private, so nothing can drain the pipe and a chatty server
 * blocks for good once the ~64 KB kernel buffer fills. It has to be a real
 * descriptor, which needs no reader.
 *
 * See the MCP server stderr entry in CLAUDE.md for the full account.
 */
function mcpStderrTarget(): 'ignore' | number {
  return openSessionSidecarFd('mcp-stderr.log') ?? 'ignore';
}

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
    stderr: mcpStderrTarget(),
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
/**
 * How a probed server's tools actually resolve in the running session.
 *
 * - `connected` — this session has a live client for the server.
 * - `knownAtStartup` — the server was in the config when this session launched.
 *   Read together with `connected`, this is the whole verdict, and collapsing
 *   the two is what let a caller delete a config it had just written correctly:
 *   a server added *since* launch was never attempted, so "not loaded" is the
 *   expected state and a restart is the ordinary next step; a server present at
 *   launch that is still not connected actually failed, and `error` says why.
 * - `live` — routed to this server right now, callable.
 * - `missing` — not in the live tool set at all.
 *
 * There is no `shadowed`: since #413 each server's tools are registered under
 * a key carrying that server's own hash, so one server's tool can no longer be
 * routed to another. The field could only ever have been `[]`, and keeping it
 * would have left user-facing copy describing a mechanism that no longer
 * exists. Both lists carry the RAW names the server reports, which is what the
 * user recognises and what {@link MCPManager.getLiveRegistration} maps forward.
 */
export interface LiveRegistration {
  connected: boolean;
  knownAtStartup: boolean;
  error?: string;
  live: string[];
  missing: string[];
}

/**
 * One registered MCP tool: the raw tool object plus the name the server itself
 * used for it.
 *
 * The raw name is retained rather than re-derived from the namespaced key
 * because it cannot always be re-derived — `mcpToolName`'s R2 rung truncates a
 * long tool name through the middle. Risk classification in particular must
 * read the server's own name (`isReadOnlyMCPSuffix` looks for a trailing verb),
 * and `mcp_verify` reports raw names back to the user, so guessing them from
 * the key would be wrong in exactly the cases that are hardest to notice.
 */
interface RegisteredTool {
  raw: string;
  tool: any;
}

/** Re-keys a server's freshly-listed tools under their namespaced names. */
function namespaceTools(
  server: string,
  tools: Record<string, any>,
): Record<string, RegisteredTool> {
  const out: Record<string, RegisteredTool> = {};
  for (const [raw, tool] of Object.entries(tools)) {
    out[mcpToolName(server, raw)] = { raw, tool };
  }
  return out;
}

export class MCPManager {
  private clients: Map<string, MCPClient> = new Map();
  private serverStatuses: ServerStatus[] = [];
  /**
   * The one authored registry: `server -> { toolName -> rawTool }`.
   *
   * Replaces a flat `tools` bag plus a parallel `toolName -> server` map,
   * which were both last-writer-wins, so two servers exporting the same tool
   * name could not coexist — the loser did not merely lose priority, it
   * vanished from its own per-server list, because that list was built by
   * INVERTING the collapsed map (#413).
   *
   * Everything flat is derived from this by {@link flattenServerTools}, so the
   * two can never disagree about a key. That is the structural fix, not a
   * discipline: there is no second place to author a name.
   */
  private serverTools: Map<string, Record<string, RegisteredTool>> = new Map();
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
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
        // No collision warning any more: a server's tools live under its own
        // key, so another server exporting the same name costs this one
        // nothing. The warning existed to report a loss that can no longer
        // happen.
        this.serverTools.set(name, namespaceTools(name, serverTools));

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
      // One assignment replaces this server's whole entry; no other server's
      // tools are reachable from here to disturb.
      this.serverTools.set(name, namespaceTools(name, serverTools));

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

      // Drop the dead server's tools. The client was closed before the retry,
      // so leaving them registered offers the model tools that can only fail —
      // and while names were flat it was worse than useless: a dead server's
      // stale entry kept occupying a name a HEALTHY server also exported, with
      // no way to fall back to the live one (#413).
      this.serverTools.delete(name);

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
   * Returns `{ server: { namespacedName: tool } }`, converted for AI SDK v4
   * compatibility.
   *
   * Each tool's `execute` method is wrapped with automatic reconnect-and-retry:
   * if a call fails, the owning server is reconnected and the call retried once.
   *
   * This is the conversion; {@link MCPManager.getTools} is a flatten of it.
   * Carries the tool OBJECTS, not just names (#413) — the name-only shape made
   * every consumer re-look-up each name in the flat bag, and that join is what
   * let the two structures disagree, silently, because
   * `dispatchServerDelegate` guarded the lookup with `if (t)`.
   */
  getServerTools(shaping?: MCPResultShapingConfig): Record<string, Record<string, any>> {
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
    const converted: Record<string, Record<string, any>> = {};
    // Converted straight into per-server buckets, so the owning server is the
    // position rather than a lookup. `getTools()` then FLATTENS this — the same
    // derive-don't-author rule the registry itself follows, and the reason
    // there is no re-grouping pass that could silently drop a key.
    for (const [serverName, serverTools] of this.serverTools.entries()) {
      converted[serverName] = {};
      for (const [name, { raw, tool }] of Object.entries(serverTools)) {
        const baseTool = this.convertTool(name, tool);
        const originalExecute = baseTool.execute;

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
              // The RAW name: this line is for the user, and the raw name is
              // the one they see in the server's own docs and in `mcp_verify`.
              printInfo(`MCP tool "${raw}" failed, reconnecting to "${serverName}"...`);
              const reconnected = await this.reconnectServer(serverName);
              const fresh = this.serverTools.get(serverName)?.[name];
              if (reconnected && fresh) {
                const freshTool = this.convertTool(name, fresh.tool);
                const retryResult = await freshTool.execute(args);
                return shape(normalizeToolResult(retryResult));
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
        // Classified on the RAW name. The prefix happens to be transparent to
        // this end-anchored check, but an R2-truncated key is not — its
        // trailing characters are the tool's tail, not its verb.
        const isRead = isReadOnlyMCPSuffix(raw);
        const meta: ToolMeta = {
          // Kept in lockstep with the registry key: the permission and block
          // gates key on the registry key while `result-cache.ts` keys on
          // `meta.name`, so a divergence would silently split them.
          name,
          // The server's own name for this tool, and the owning server. Both
          // are authored here and would otherwise be trapped inside the
          // manager, forcing every consumer into a lossy re-parse of the key.
          rawName: raw,
          kind: isRead ? 'read' : 'write',
          category: `mcp.${serverName}`,
          deterministic: false,
          sideEffect: isRead ? 'network' : 'local',
        };
        converted[serverName][name] = attachMeta(wrapped, meta);
      }
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
   * Every MCP tool in one name-keyed bag.
   *
   * Derived from {@link MCPManager.getServerTools}, never assembled separately:
   * the flat form is what a delegation-off dispatch and the tool-wrapper
   * registry need, but authoring it independently is what allowed the two
   * shapes to disagree in the first place (#413).
   */
  getTools(shaping?: MCPResultShapingConfig): Record<string, any> {
    return flattenServerTools(this.getServerTools(shaping));
  }

  /**
   * `{ server: [rawToolName, …] }` — the names the servers themselves use, for
   * display.
   *
   * The registry key is namespaced and, at the truncation ladder's last rung,
   * not invertible; `mcpToolName`'s docstring says plainly that nothing
   * downstream may recover the raw name from it. So the UI gets the
   * authoritative value from here rather than re-deriving a lossy one.
   */
  getServerToolNames(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [server, tools] of this.serverTools.entries()) {
      out[server] = Object.values(tools).map((t) => t.raw);
    }
    return out;
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
    // One authored structure, one derived — see `flattenServerTools`.
    const serverTools = this.getServerTools(shaping);
    const tools = flattenServerTools(serverTools);
    return {
      tools,
      serverNames: this.getConnectedServerNames(),
      serverTools,
      // Built here, over the whole live surface, because this is the single
      // assembler — a consumer building its own would only see its dispatch's
      // registry and could call an ambiguous name unambiguous. Delegate keys
      // are included: they are exposed to the model and were hashed too, so a
      // grant stored against `delegate_playwright` must still resolve.
      resolveAlias: makeAliasResolver([
        ...Object.keys(tools),
        ...this.getConnectedServerNames().map((s) => `delegate_${mcpServerSegment(s)}`),
      ]),
    };
  }

  /**
   * Reconciles a fresh {@link verifyMCPServer} probe against the tools actually
   * wired into THIS running session. A probe spawns the server in isolation, so
   * it reports the server's own health — which says nothing about whether the
   * running agent can call those tools. Turns a misleading "healthy, 23 tools"
   * into an honest account of what is callable right now. See
   * {@link LiveRegistration} for what each field means.
   */
  getLiveRegistration(name: string, probeToolNames: string[]): LiveRegistration {
    const status = this.serverStatuses.find((s) => s.name === name);
    const live: string[] = [];
    const missing: string[] = [];
    const own = this.serverTools.get(name) ?? {};
    // Map each probed name FORWARD into the key this server would register it
    // under, rather than reverse-parsing live keys. `verifyMCPServer` spawns
    // the server in isolation and reports the RAW names it exports, so the two
    // sides speak different alphabets; comparing them directly would report
    // every tool of every healthy server as `missing` — and `mcp_verify` turns
    // that into a ⚠ verdict, which the `mcp-manager` specialist has previously
    // answered by deleting a correct config.
    for (const t of probeToolNames) {
      (own[mcpToolName(name, t)] ? live : missing).push(t);
    }
    return {
      connected: status?.connected ?? false,
      // `serverConfigs` is populated once, from the config as it was at
      // startup, and is never added to afterwards — so `has` is the literal
      // statement of this field. Deriving it from a `serverStatuses` row
      // instead would mean "has ever been attempted", which `doReconnectServer`
      // can push to at runtime.
      knownAtStartup: this.serverConfigs.has(name),
      error: status?.error,
      live,
      missing,
    };
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
