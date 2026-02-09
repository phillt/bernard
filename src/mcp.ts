import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { printInfo, printError } from './output.js';

const CONFIG_PATH = path.join(os.homedir(), '.bernard', 'mcp.json');

interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

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
        const transport = new Experimental_StdioMCPTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env
            ? { ...process.env as Record<string, string>, ...serverConfig.env }
            : undefined,
        });

        const client = await createMCPClient({ transport });
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

  getTools(): Record<string, any> {
    return this.tools;
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
