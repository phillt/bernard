import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { attachMeta } from '../framework/tools/adapter.js';
import type { AgentContext } from '../framework/context.js';
import { mcpServerSegment } from '../mcp-names.js';

/**
 * Per-server MCP delegation (#296). The main agent sees one thin
 * `delegate_<server>(task)` tool per connected MCP server instead of that
 * server's full set of tool schemas. When invoked, a helper sub-agent runs the
 * actual MCP calls in an isolated, throwaway context (scoped to just that
 * server's tools + `ask_user`), absorbs the bulky raw results, and returns a
 * small abstracted summary. This keeps BOTH cost drivers — resident tool
 * schemas and raw tool results — out of the main agent's context.
 */

/**
 * Tool names routed to `server`, from the per-server map threaded at bootstrap.
 * Exported for `delegate-dispatch.ts`, which scopes a helper to the same set.
 */
export function serverToolNames(ctx: AgentContext, server: string): string[] {
  return Object.keys(serverToolMap(ctx, server));
}

/**
 * The tools routed to `server`, as a ready-to-use registry.
 *
 * Returned straight from the per-server map rather than assembled by looking
 * each name up in the flat bag (#413). That lookup was a join between two
 * independently-authored structures, and `if (t)` silently dropped anything
 * they disagreed about — so a mismatch produced a helper with no tools whose
 * system prompt still listed them, the #305 failure shape.
 */
export function serverToolMap(ctx: AgentContext, server: string): Record<string, Tool> {
  return (ctx.mcp.serverTools?.[server] ?? {}) as Record<string, Tool>;
}

/**
 * Builds one `delegate_<server>` tool. The tool's description names the server
 * and a few of its tools so the main agent routes intent to the right door on
 * the first try. Classified `kind: 'read'` like the `task` dispatch tool — the
 * helper's own tool calls carry their real risk and are gated individually
 * inside the helper, so gating the delegation entry point too would
 * double-prompt.
 *
 * `toolName` is the registry key the tool will be exposed under; it defaults to
 * `delegate_<sanitized-server>` but callers pass the collision-disambiguated key
 * (see {@link createDelegateTools}) so `meta.name` stays in lockstep with the
 * key the model — and the augment/permission layers — actually see.
 */
export function createDelegateTool(
  ctx: AgentContext,
  server: string,
  toolName: string = `delegate_${mcpServerSegment(server)}`,
): Tool {
  const toolNames = serverToolNames(ctx, server);
  const preview = toolNames.slice(0, 8).join(', ');
  const more = toolNames.length > 8 ? `, +${toolNames.length - 8} more` : '';
  const capabilityBlurb = preview ? ` Its tools: ${preview}${more}.` : '';
  return attachMeta(
    tool({
      description: `Delegate a natural-language task to the "${server}" MCP server.${capabilityBlurb} A helper runs the actual ${server} tool calls in an isolated context and returns a concise summary — you never see the raw results, so hand off the whole sub-task (e.g. "find the latest email from Jody and summarize it") rather than orchestrating individual calls yourself.`,
      parameters: z.object({
        task: z
          .string()
          .min(1)
          .describe(
            `What you want done with ${server}, in plain language. Be specific about the desired outcome; the helper decides which ${server} tools to call.`,
          ),
        context: z
          .string()
          .optional()
          .describe(
            'Optional extra context the helper needs (ids, prior findings, constraints) that is not obvious from the task alone.',
          ),
      }),
      // Dynamic import: the dispatcher pulls in `runDefinition` / `runPAC`,
      // and `run.ts` imports THIS module to resolve the delegation surface
      // (#315). Importing it statically would close that loop at load time.
      // Deferring to first invocation costs one already-cached module lookup.
      execute: async ({ task, context }, execOptions): Promise<string> => {
        const { dispatchServerDelegate } = await import('./delegate-dispatch.js');
        return dispatchServerDelegate(ctx, {
          server,
          task,
          context,
          abortSignal: execOptions?.abortSignal,
        });
      },
    }),
    {
      name: toolName,
      kind: 'read',
      deterministic: false,
      sideEffect: 'none',
      cacheable: false,
      category: `mcp-delegate.${server}`,
    },
  ) as unknown as Tool;
}

/**
 * The MCP tool bag a dispatched agent should carry, honoring
 * `BERNARD_MCP_DELEGATION` (#296, #305).
 *
 * Delegation on  → thin `delegate_<server>` tools, one per server.
 * Delegation off → the raw per-tool schemas.
 *
 * Returns ONE bag because the two are mutually exclusive by construction, and
 * `createTools` spreads its `mcpTools` argument last — so callers pass the
 * result straight through as that argument and need no second spread. An
 * earlier two-field shape made every call site splice two values into two
 * different places, where dropping the second half failed silently.
 *
 * Extracted because five definitions need the identical gate — main, sub,
 * task, specialist and the PAC actor — and a copy that drifts silently
 * re-introduces the 143-schema prefix this exists to remove.
 */
export function mcpToolSurface(ctx: AgentContext): Record<string, Tool> {
  if (!ctx.config.mcpDelegation) return ctx.mcp.tools;
  const delegates = createDelegateTools(ctx);
  // Fail open: a foreign or test context carrying MCP tools but no usable
  // server map would otherwise get neither delegates nor raw tools — a total
  // loss of MCP access rather than the intended reduction. Paying the schema
  // cost beats going dark. Internal origins can no longer reach this state:
  // `MCPManager.snapshot()` is the single assembler and `serverTools` is
  // required on `AgentContextMCP`.
  return Object.keys(delegates).length > 0 ? delegates : ctx.mcp.tools;
}

/**
 * Builds the full set of `delegate_<server>` tools for the main agent — one per
 * connected server that actually has tools. Servers are keyed by their
 * sanitized tool name; a name collision (two servers sanitizing to the same
 * token) is disambiguated with a numeric suffix so no delegate silently
 * shadows another.
 */
export function createDelegateTools(ctx: AgentContext): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const server of ctx.mcp.serverNames) {
    if (serverToolNames(ctx, server).length === 0) continue; // nothing to delegate
    // `mcpServerSegment` carries a hash of the raw server name, so two servers
    // whose names sanitize alike can no longer collide and the numeric-suffix
    // loop that used to disambiguate them is gone. That loop assigned suffixes
    // in iteration order, which meant editing `mcp.json` could renumber a
    // DIFFERENT server's key — and this key is persisted, in permission grants
    // and tool-profile filenames (#413).
    const key = `delegate_${mcpServerSegment(server)}`;
    tools[key] = createDelegateTool(ctx, server, key);
  }
  return tools;
}
