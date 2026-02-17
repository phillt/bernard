import { tool } from 'ai';
import { z } from 'zod';
import { addMCPUrlServer } from '../mcp.js';

export function createMCPAddUrlTool() {
  return tool({
    description:
      'Add a URL-based MCP server (SSE or HTTP endpoint). Use this when given an MCP server URL. Changes take effect after restarting Bernard.',
    parameters: z.object({
      key: z.string().describe('Unique name for this server, e.g. "my-mcp"'),
      url: z.string().describe('The MCP server URL, e.g. "http://localhost:6288/web/sse"'),
    }),
    execute: async ({ key, url }): Promise<string> => {
      try {
        const type = url.endsWith('/sse') ? ('sse' as const) : ('sse' as const);
        addMCPUrlServer(key, url, type);
        return `MCP server added:\n  Key: ${key}\n  URL: ${url}\n  Transport: ${type}\n\nRestart Bernard for the server to connect.`;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error adding server: ${msg}`;
      }
    },
  });
}
