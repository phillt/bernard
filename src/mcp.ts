import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { jsonSchema } from 'ai';
import { printInfo, printError } from './output.js';

const CONFIG_PATH = path.join(os.homedir(), '.bernard', 'mcp.json');

interface MCPStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface MCPUrlConfig {
  url: string;
  type?: 'sse' | 'http';
  headers?: Record<string, string>;
}

type MCPServerConfig = MCPStdioConfig | MCPUrlConfig;

interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

interface ServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export class MCPManager {
  private clients: Map<string, MCPClient> = new Map();
  private serverStatuses: ServerStatus[] = [];
  private tools: Record<string, any> = {};
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private toolServerMap: Map<string, string> = new Map();
  // Per-server reconnection lock to coalesce concurrent reconnect attempts
  private reconnectPromises: Map<string, Promise<boolean>> = new Map();

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

  private async createClientForConfig(serverConfig: MCPServerConfig): Promise<MCPClient> {
    if ('url' in serverConfig) {
      return createMCPClient({
        transport: {
          type: serverConfig.type ?? 'sse',
          url: serverConfig.url,
          headers: serverConfig.headers,
        },
      });
    } else {
      const transport = new Experimental_StdioMCPTransport({
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env
          ? { ...process.env as Record<string, string>, ...serverConfig.env }
          : undefined,
      });
      return createMCPClient({ transport });
    }
  }

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
        const client = await this.createClientForConfig(serverConfig);
        return { name, client };
      })
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const name = serverEntries[i][0];

      if (result.status === 'fulfilled') {
        const { client } = result.value;
        this.clients.set(name, client);

        try {
          const serverTools = await client.tools();
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
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.serverStatuses.push({
            name,
            connected: false,
            toolCount: 0,
            error: message,
          });
          printError(`MCP server "${name}" failed to list tools: ${message}`);
        }
      } else {
        const message = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
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

  private async doReconnectServer(name: string): Promise<boolean> {
    const config = this.serverConfigs.get(name);
    if (!config) return false;

    // Close the existing client
    const existingClient = this.clients.get(name);
    if (existingClient) {
      try { await existingClient.close(); } catch { /* ignore */ }
      this.clients.delete(name);
    }

    try {
      const client = await this.createClientForConfig(config);
      this.clients.set(name, client);

      const serverTools = await client.tools();
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
      const statusIndex = this.serverStatuses.findIndex(s => s.name === name);
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

      const statusIndex = this.serverStatuses.findIndex(s => s.name === name);
      const newStatus: ServerStatus = { name, connected: false, toolCount: 0, error: message };
      if (statusIndex >= 0) {
        this.serverStatuses[statusIndex] = newStatus;
      } else {
        this.serverStatuses.push(newStatus);
      }

      return false;
    }
  }

  private convertTool(name: string, tool: any): any {
    if (tool.type === 'dynamic') {
      const { type, inputSchema, ...rest } = tool;
      return {
        ...rest,
        parameters: jsonSchema(inputSchema.jsonSchema),
      };
    }
    return tool;
  }

  getTools(): Record<string, any> {
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

      converted[name] = {
        ...baseTool,
        // Retry wrapper: on failure, reconnect the server and retry once.
        // If the retry also fails, the *retry* error is thrown (not the original)
        // so the caller sees the most recent failure reason.
        execute: async (args: unknown) => {
          try {
            return await originalExecute(args);
          } catch (error) {
            if (serverName) {
              printInfo(`MCP tool "${name}" failed, reconnecting to "${serverName}"...`);
              const reconnected = await this.reconnectServer(serverName);
              if (reconnected && this.tools[name]) {
                const freshTool = this.convertTool(name, this.tools[name]);
                return await freshTool.execute(args);
              }
            }
            throw error;
          }
        },
      };
    }
    return converted;
  }

  getServerStatuses(): ServerStatus[] {
    return this.serverStatuses;
  }

  getConnectedServerNames(): string[] {
    return this.serverStatuses
      .filter(s => s.connected)
      .map(s => s.name);
  }

  async close(): Promise<void> {
    const closePromises = Array.from(this.clients.values()).map(client =>
      client.close().catch(() => {})
    );
    await Promise.allSettled(closePromises);
    this.clients.clear();
  }
}

export function listMCPServers(): { key: string; command?: string; args?: string[]; url?: string; type?: 'sse' | 'http' }[] {
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

export function addMCPServer(
  key: string,
  command: string,
  args?: string[],
  env?: Record<string, string>
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

export function addMCPUrlServer(
  key: string,
  url: string,
  type?: 'sse' | 'http',
  headers?: Record<string, string>
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
    const hint = validKeys.length > 0
      ? ` Valid keys: ${validKeys.join(', ')}`
      : ' No servers configured.';
    throw new Error(`MCP server "${key}" not found.${hint}`);
  }

  delete config.mcpServers[key];
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
