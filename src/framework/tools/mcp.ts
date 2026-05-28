import type { Tool } from 'ai';
import type { BernardTool, ToolMeta, ToolResult } from './types.js';
import { isToolResult } from './types.js';

/**
 * Wraps an MCP tool at the boundary so it satisfies `BernardTool` with a
 * generic envelope. This is the **one place** that retains heuristic error
 * detection for MCP-provided returns — any string starting with `"Error"` (or
 * a result that fails to serialize) is treated as an error envelope. Thrown
 * exceptions in the MCP `execute` (reconnect/network) propagate up as
 * `status: 'error'` rather than throwing, so the augment layer can record
 * them deterministically.
 *
 * Pass the AI-SDK MCP `Tool` (already reconnect-wrapped by `MCPManager.getTools`)
 * plus the originating server name. Defaults to `kind: 'inert'` — callers that
 * know an MCP tool is read-only can override via the optional `metaOverride`.
 */
export function wrapMCPTool(
  name: string,
  mcpTool: Tool,
  serverName: string,
  metaOverride?: Partial<ToolMeta>,
): BernardTool<unknown, unknown> {
  const meta: ToolMeta = {
    name,
    kind: 'inert',
    category: `mcp.${serverName}`,
    deterministic: false,
    sideEffect: 'external-api',
    ...metaOverride,
  };

  return {
    meta,
    description: typeof mcpTool.description === 'string' ? mcpTool.description : '',
    parameters: mcpTool.parameters as never,
    execute: async (args, opts): Promise<ToolResult<unknown>> => {
      try {
        const value = await (mcpTool as { execute: (a: unknown, o: unknown) => unknown }).execute(
          args,
          opts,
        );
        if (isToolResult(value)) return value as ToolResult<unknown>;
        // Heuristic: MCP servers historically return string errors prefixed
        // with "Error". detectToolError used to catch these; localize it here.
        if (typeof value === 'string' && value.startsWith('Error')) {
          return {
            status: 'error',
            error: { type: 'exec_failed', message: value.slice(0, 200) },
          };
        }
        return { status: 'ok', result: value };
      } catch (e) {
        return {
          status: 'error',
          error: {
            type: 'exec_failed',
            message: e instanceof Error ? e.message : String(e),
          },
        };
      }
    },
    serializeForModel: (r) => {
      if (r.status === 'ok') return r.result;
      // Match the historical MCP error string shape so model-facing bytes are stable.
      return `Error: ${r.error.message}`;
    },
  };
}
