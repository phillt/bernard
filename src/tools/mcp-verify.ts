import { tool } from 'ai';
import { z } from 'zod';
import { getMCPServer, verifyMCPServer } from '../mcp.js';
import { attachMeta } from '../framework/tools/adapter.js';

/**
 * Creates the `mcp_verify` tool: test-connects a configured MCP server and
 * reports whether it actually works, **without restarting Bernard**. This is
 * the "check it" half of MCP management — after adding/editing a server, call
 * this to confirm it speaks the protocol and surfaces tools, instead of
 * blindly trusting a written config (and discovering a hang on next launch).
 */
export function createMCPVerifyTool() {
  return attachMeta(
    tool({
      description:
        'Test-connect a configured MCP server WITHOUT restarting Bernard. Spawns/connects it with a timeout, lists its tools, and reports success + tool count or the failure reason (e.g. handshake timeout from an HTTP server launched as stdio, missing --stdio flag, bad API-key env var, or command not found). Always run this after adding or editing an MCP server.',
      parameters: z.object({
        key: z
          .string()
          .describe('Name/key of the MCP server in the config to verify (see mcp_config list).'),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(60_000)
          .optional()
          .describe('Connection timeout in milliseconds (default 15000).'),
      }),
      execute: async ({ key, timeoutMs }): Promise<string> => {
        const config = getMCPServer(key);
        if (!config) {
          return `Error: no MCP server named "${key}" is configured. Use mcp_config { action: "list" } to see configured servers.`;
        }
        const r = await verifyMCPServer(config, timeoutMs ? { timeoutMs } : {});
        if (r.ok) {
          const sample = r.toolNames.slice(0, 10).join(', ');
          const more = r.toolCount > r.toolNames.slice(0, 10).length ? ', …' : '';
          return `✓ "${key}" connected in ${r.durationMs}ms — ${r.toolCount} tool(s)${sample ? `: ${sample}${more}` : ''}.`;
        }
        return `✗ "${key}" failed to connect after ${r.durationMs}ms${r.timedOut ? ' [timed out]' : ''}: ${r.error}`;
      },
    }),
    {
      // A read-only diagnostic probe: it spawns the *user's own configured*
      // server briefly and only lists tools (no tool is invoked).
      name: 'mcp_verify',
      kind: 'read',
      deterministic: false,
      sideEffect: 'local',
      cacheable: false,
    },
  );
}
