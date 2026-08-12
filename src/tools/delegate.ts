import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { attachMeta } from '../framework/tools/adapter.js';
import type { AgentContext } from '../framework/context.js';
import { runDefinition } from '../framework/agents/run.js';
import { runPAC } from '../framework/pac/run-pac.js';
import {
  mcpDelegateDefinition,
  buildDelegateSystemPrompt,
} from '../framework/agents/mcp-delegate.js';
import { acquireSlot, releaseSlot, getMaxConcurrentAgents } from './agent-pool.js';
import { createAskUserTool } from './ask-user.js';
import { debugLog } from '../logger.js';

/**
 * Per-server MCP delegation (#296). The main agent sees one thin
 * `delegate_<server>(task)` tool per connected MCP server instead of that
 * server's full set of tool schemas. When invoked, a helper sub-agent runs the
 * actual MCP calls in an isolated, throwaway context (scoped to just that
 * server's tools + `ask_user`), absorbs the bulky raw results, and returns a
 * small abstracted summary. This keeps BOTH cost drivers — resident tool
 * schemas and raw tool results — out of the main agent's context.
 */

/** Tool names routed to `server`, from the per-server map threaded at bootstrap. */
function serverToolNames(ctx: AgentContext, server: string): string[] {
  return ctx.mcp.serverTools?.[server] ?? [];
}

/**
 * Runs a delegated task against one MCP server's tools in an isolated helper
 * sub-agent and returns its capped summary. The parent `ctx` is passed straight
 * to `runDefinition`, so `toolOptions` AND `policyDecision` are forwarded intact
 * — the block gate (#179) and confirm gate (#144) fire on the helper's own MCP
 * write calls, and MCP results register on the shared provenance store. Building
 * a fresh context that dropped `policyDecision` would silently bypass the
 * read-only gate; the epic's finding #1 makes forwarding a hard requirement.
 */
export async function dispatchServerDelegate(
  ctx: AgentContext,
  args: { server: string; task: string; context?: string; abortSignal?: AbortSignal },
): Promise<string> {
  const { server, task, context, abortSignal } = args;
  const slot = acquireSlot();
  if (!slot) {
    return `Could not delegate to "${server}": maximum concurrent agents (${getMaxConcurrentAgents()}) reached. Try again in a moment.`;
  }
  try {
    const toolNames = serverToolNames(ctx, server);
    const childTools: Record<string, Tool> = {};
    for (const name of toolNames) {
      const t = ctx.mcp.tools[name];
      if (t) childTools[name] = t;
    }
    // Give the helper a direct line to the user for mid-task disambiguation
    // (suspend-ask-resume through the live REPL popup). The tool-wrapper
    // registry omits `ask_user`; delegation needs it because MCP tasks
    // routinely need "which account?" clarification.
    childTools.ask_user = createAskUserTool(ctx.toolOptions.askUser) as unknown as Tool;

    const systemPrompt = buildDelegateSystemPrompt(server, toolNames);
    const telemetrySite = `mcp:${server}`;
    const { formatted, stepLimitHit } = await runDefinition(
      ctx,
      mcpDelegateDefinition,
      { server, task, context, slotId: slot.id, childTools, systemPrompt },
      {
        abortSignal,
        // Attribute the helper's spend to its own layer (#299) so the
        // delegation win is measurable in `bernard usage` / the UsageViewer.
        telemetrySite,
      },
    );

    // Self-escalation (#296 Phase 2E; see `BERNARD_MCP_DELEGATE_ESCALATION`).
    // Only a step-limited single loop escalates — once — to a PAC pass over the
    // SAME slot + scoped `childTools` (MCP schemas stay contained), carrying the
    // partial findings forward so it continues rather than restarts.
    if (stepLimitHit && ctx.config.mcpDelegateEscalation) {
      const partial = `A single-loop attempt hit its step limit before completing this task. Continue from these partial findings rather than starting over:\n${formatted}`;
      const escalationContext = context ? `${context}\n\n${partial}` : partial;
      debugLog('delegate:escalate', { server, task: task.slice(0, 120) });
      const pac = await runPAC(
        ctx,
        { task, context: escalationContext, slotId: slot.id, childTools },
        { abortSignal, telemetrySite },
      );
      debugLog('delegate:escalated', {
        server,
        verdict: pac.verdict,
        retries: pac.retries,
      });
      return pac.formatted;
    }

    return formatted;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog('delegate:error', { server, message });
    return `Delegation to "${server}" failed: ${message}`;
  } finally {
    releaseSlot();
  }
}

/** Tool-name-safe form of a server name (AI-SDK tool names: `[a-zA-Z0-9_-]`). */
export function sanitizeServerToolName(server: string): string {
  return server.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Builds one `delegate_<server>` tool. The tool's description names the server
 * and a few of its tools so the main agent routes intent to the right door on
 * the first try. Classified `kind: 'read'` like the `task` dispatch tool — the
 * helper's own tool calls carry their real risk and are gated individually
 * inside the helper, so gating the delegation entry point too would
 * double-prompt.
 */
export function createDelegateTool(ctx: AgentContext, server: string): Tool {
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
      execute: async ({ task, context }, execOptions): Promise<string> =>
        dispatchServerDelegate(ctx, {
          server,
          task,
          context,
          abortSignal: execOptions?.abortSignal,
        }),
    }),
    {
      name: `delegate_${sanitizeServerToolName(server)}`,
      kind: 'read',
      deterministic: false,
      sideEffect: 'none',
      cacheable: false,
      category: `mcp-delegate.${server}`,
    },
  ) as unknown as Tool;
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
    let key = `delegate_${sanitizeServerToolName(server)}`;
    if (tools[key]) {
      let n = 2;
      while (tools[`${key}_${n}`]) n++;
      key = `${key}_${n}`;
    }
    tools[key] = createDelegateTool(ctx, server);
  }
  return tools;
}
