import { tool } from 'ai';
import { z } from 'zod';
import { listMCPServers, addMCPServer, removeMCPServer, getMCPServer } from '../mcp.js';

export function createMCPConfigTool() {
  return tool({
    description:
      'Manage MCP server configuration. Add, remove, list, or inspect MCP servers. Changes take effect after restarting Bernard.',
    parameters: z.object({
      action: z.enum(['list', 'add', 'remove', 'get']).describe('The action to perform'),
      key: z.string().optional().describe('Server name/key (required for add, remove, get)'),
      command: z.string().optional().describe('Executable to run, e.g. "npx", "python", "node" (required for add)'),
      args: z.array(z.string()).optional().describe('Command arguments, e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]'),
      env: z.record(z.string()).optional().describe('Environment variables to pass to the server process'),
    }),
    execute: async ({ action, key, command, args, env }): Promise<string> => {
      switch (action) {
        case 'list': {
          try {
            const servers = listMCPServers();
            if (servers.length === 0) return 'No MCP servers configured.';

            const lines = servers.map(s => {
              const argsStr = s.args.length > 0 ? `\n    Args: ${s.args.join(' ')}` : '';
              return `  - ${s.key}\n    Command: ${s.command}${argsStr}`;
            });

            return `MCP servers (${servers.length}):\n${lines.join('\n')}`;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error listing servers: ${msg}`;
          }
        }

        case 'add': {
          if (!key) return 'Error: key is required for add action.';
          if (!command) return 'Error: command is required for add action.';

          try {
            addMCPServer(key, command, args, env);
            const argsStr = args && args.length > 0 ? `\n  Args: ${args.join(' ')}` : '';
            const envStr = env && Object.keys(env).length > 0
              ? `\n  Env: ${Object.keys(env).join(', ')}`
              : '';
            return `MCP server added:\n  Key: ${key}\n  Command: ${command}${argsStr}${envStr}\n\nRestart Bernard for the server to connect.`;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error adding server: ${msg}`;
          }
        }

        case 'remove': {
          if (!key) return 'Error: key is required for remove action.';

          try {
            removeMCPServer(key);
            return `MCP server "${key}" removed. Restart Bernard for changes to take effect.`;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error removing server: ${msg}`;
          }
        }

        case 'get': {
          if (!key) return 'Error: key is required for get action.';

          try {
            const server = getMCPServer(key);
            if (!server) {
              const servers = listMCPServers();
              const hint = servers.length > 0
                ? ` Available servers: ${servers.map(s => s.key).join(', ')}`
                : ' No servers configured.';
              return `MCP server "${key}" not found.${hint}`;
            }

            const argsStr = server.args && server.args.length > 0
              ? `\n  Args: ${server.args.join(' ')}`
              : '';
            const envStr = server.env && Object.keys(server.env).length > 0
              ? `\n  Env: ${Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join(', ')}`
              : '';
            return `MCP server "${key}":\n  Command: ${server.command}${argsStr}${envStr}`;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error getting server: ${msg}`;
          }
        }

        default:
          return `Unknown action: ${action}`;
      }
    },
  });
}
