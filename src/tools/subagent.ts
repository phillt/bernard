import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { resolveProviderAndModel, defaultProviderErrorMessage } from '../config.js';
import { printSubAgentStart, printSubAgentEnd } from '../output.js';
import type { AgentContext } from '../framework/context.js';
import { definitions } from '../framework/agents/registry.js';
import { runDefinition } from '../framework/agents/run.js';
import { registerBuiltinDefinitions } from '../framework/agents/index.js';
import type { SubAgentInput } from '../framework/agents/sub.js';
import { runPAC } from '../framework/pac/run-pac.js';
import { withSlot, _resetPool, getMaxConcurrentAgents } from './agent-pool.js';
import { isDispatchCancellation } from '../error-taxonomy.js';

/**
 * Resets the shared concurrency pool state.
 *
 * @internal Exported for testing only.
 */
export function _resetSubAgentState(): void {
  _resetPool();
}

/**
 * Creates the sub-agent delegation tool for parallel task execution.
 *
 * Each sub-agent receives its own `runDefinition` invocation with the
 * {@link subAgentDefinition} (ephemeral history, half the main step budget).
 * Up to {@link getMaxConcurrentAgents} may run concurrently — this wrapper
 * owns the pool-slot dance because slot ids are also used as the per-call
 * log prefix.
 *
 * @param ctx - Assembled AgentContext (config, stores, mcp, toolOptions, optional RAG).
 */
export function createSubAgentTool(ctx: AgentContext): Tool {
  registerBuiltinDefinitions();
  return tool({
    description:
      'Delegate a task to an independent sub-agent that runs in parallel. Sub-agents have NO conversation history and limited steps — your task description must be fully self-contained and highly prescriptive. Specify exact commands, file paths, expected output format, edge cases, and success/failure criteria. Call multiple times in one response for parallel execution.',
    parameters: z.object({
      task: z
        .string()
        .describe(
          'A detailed, self-contained task description. Include: (1) specific objective and expected output format, (2) exact file paths, commands, or URLs, (3) edge cases and what to do if something fails, (4) what "done" looks like. The sub-agent has zero prior context.',
        ),
      context: z.string().optional().describe('Optional additional context to help the sub-agent'),
      provider: z
        .string()
        .optional()
        .describe(
          'Optional provider override for this sub-agent (e.g. "xai"). Falls back to global config.',
        ),
      model: z
        .string()
        .optional()
        .describe(
          'Optional model override for this sub-agent (e.g. "grok-code-fast-1"). Falls back to global config.',
        ),
    }),
    execute: async ({ task, context, provider, model }, execOptions) => {
      const resolution = resolveProviderAndModel({ provider, model, config: ctx.config });
      if (!resolution.ok) {
        return `Error: ${defaultProviderErrorMessage(resolution.provider, resolution.envVar, resolution.isCustom)}`;
      }

      return withSlot(
        async (slot) => {
          const id = slot.id;
          printSubAgentStart(id, task);

          try {
            const runOpts = {
              abortSignal: execOptions.abortSignal,
              // Forward only the user-supplied provider/model so resolveSiteModel
              // can fall through to the modelMode tier table when neither is set.
              overrides: { provider, model },
            };
            let formatted: string;
            if (ctx.config.subagentPac) {
              // `runPAC` owns the final cap (and reserves space for the FAIL
              // footer); re-capping here would risk truncating that footer away.
              const pacResult = await runPAC(ctx, { task, context, slotId: id }, runOpts);
              formatted = pacResult.formatted;
              // Snapshot the verdict for the Agent Status overlay (#140). Last
              // write wins across nested / parallel sub-agents — fine, this is a
              // user-facing peek, not a log.
              ctx.verification.setLast({
                verdict: pacResult.verdict,
                reason: pacResult.reason,
                source: task.slice(0, 80),
              });
            } else {
              const def = definitions.get<SubAgentInput, string>('sub');
              const result = await runDefinition(ctx, def, { task, context, slotId: id }, runOpts);
              formatted = result.formatted;
            }
            printSubAgentEnd(id);
            return formatted;
          } catch (err: unknown) {
            printSubAgentEnd(id);
            // A cancelled dispatch unwinds; a failed one is a tool result (#327).
            // The `Error:` prefix is load-bearing, not decoration: it is what
            // `detectResultFailure` reads (#364). Without it the failure below
            // registers as citable evidence and bumps this tool's successCount.
            if (isDispatchCancellation(err)) throw err;
            const message = err instanceof Error ? err.message : String(err);
            return `Error: Sub-agent failed: ${message}`;
          }
        },
        () =>
          `Error: Maximum concurrent sub-agents (${getMaxConcurrentAgents()}) reached. Wait for existing sub-agents to finish.`,
      );
    },
  });
}
