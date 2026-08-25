import type { Tool } from 'ai';
import type { AgentContext } from '../framework/context.js';
import { runDefinition } from '../framework/agents/run.js';
import { runPAC } from '../framework/pac/run-pac.js';
import {
  mcpDelegateDefinition,
  buildDelegateSystemPrompt,
} from '../framework/agents/mcp-delegate.js';
import { acquireSlot, releaseSlot } from './agent-pool.js';
import { createAskUserTool } from './ask-user.js';
import { serverToolNames } from './delegate.js';
import { debugLog } from '../logger.js';

/**
 * The invocation half of per-server MCP delegation (#296), split from
 * `delegate.ts` so that building the delegation SURFACE stays independent of
 * the agent runner. See the `await import()` in `delegate.ts` for why.
 */

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
  // `nested`: this helper runs INSIDE a dispatch that already holds a slot, so
  // it must not compete for one (#305). Sub-agents carry `delegate_*` tools, and
  // counting both against one flat cap would starve every helper the moment
  // parallel sub-agents fill the pool — silently removing MCP access exactly
  // when fan-out is highest. Nesting is bounded at one level: this helper's
  // registry can never contain a `delegate_*` tool.
  // `nested` never returns null, so there is no pool-exhausted branch here.
  const slot = acquireSlot({ nested: true });
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
