import type { Tool } from 'ai';
import type { BernardTool, ToolMeta, ToolResult } from './types.js';
import { isToolResult } from './types.js';
import { isReadOnlyMCPSuffix } from '../../risk.js';
import { normalizeToolResult } from '../../text.js';
import { detectResultFailure } from '../../tool-result-shape.js';

/**
 * Wraps an MCP tool at the boundary so it satisfies `BernardTool` with a
 * generic envelope. Non-throwing failures are recognized by shape via
 * `detectResultFailure` (#360) — the `CallToolResult` envelope's `isError`, a
 * flagged content entry, or the historical `"Error"`-prefixed string — and
 * become `status: 'error'`. Thrown exceptions in the MCP `execute`
 * (reconnect/network) also come back as `status: 'error'` rather than throwing,
 * so the augment layer can record them deterministically.
 *
 * Pass the AI-SDK MCP `Tool` (already reconnect-wrapped by `MCPManager.getTools`)
 * plus the originating server name. The default `kind` is derived from the
 * tool's name suffix (`isReadOnlyMCPSuffix`): names ending in
 * `search|list|find|get|query|read|lookup` are treated as `read`; everything
 * else is treated as `write`. This drives the risk-based confirmation gate
 * (#144) so write-style MCP tools (Gmail send, Calendar create, etc.) are
 * surfaceable without per-tool config. Callers can still override with
 * `metaOverride` when they know better than the heuristic.
 */
export function wrapMCPTool(
  name: string,
  mcpTool: Tool,
  serverName: string,
  metaOverride?: Partial<ToolMeta>,
): BernardTool<unknown, unknown> {
  // Risk-based default: read-only suffix → kind 'read' (low risk, never
  // prompts); everything else → kind 'write' with sideEffect 'local' (medium
  // risk, prompts only in strict mode). 'external-api' would imply high risk
  // out of the box; we leave that opt-in to follow-up `mcp.json` overrides.
  const inferredKind: ToolMeta['kind'] = isReadOnlyMCPSuffix(name) ? 'read' : 'write';
  const meta: ToolMeta = {
    name,
    kind: inferredKind,
    category: `mcp.${serverName}`,
    deterministic: false,
    sideEffect: inferredKind === 'read' ? 'network' : 'local',
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
        // A non-throwing MCP failure — the `CallToolResult` envelope's
        // `isError`, or the historical "Error"-prefixed string — is an error
        // envelope, not a success (#360). The string case alone was the whole
        // check here, so a server reporting a dead transport the way the spec
        // says to (`{content, isError: true}`) came back `status: 'ok'`.
        const failure = detectResultFailure(value);
        if (failure !== undefined) {
          return { status: 'error', error: { type: 'exec_failed', message: failure } };
        }
        return { status: 'ok', result: normalizeToolResult(value) };
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
