import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { resolveProviderAndModel, defaultProviderErrorMessage } from '../config.js';
import { printSpecialistStart, printSpecialistEnd } from '../output.js';
import type { AgentContext } from '../framework/context.js';
import { PlanStore } from '../plan-store.js';
import {
  definitions,
  registerBuiltinDefinitions,
  specialistDefinition,
  type SpecialistInput,
} from '../framework/agents/index.js';
import { runDefinition } from '../framework/agents/run.js';
import { withSlot, getMaxConcurrentAgents } from './agent-pool.js';

/**
 * Creates the specialist execution tool for running tasks through a saved
 * specialist profile.
 *
 * The dispatch wrapper owns the four concerns the generic `createDispatchTool`
 * factory cannot: (1) the specialist-existence check (so a missing id returns
 * a friendly error before any LLM call), (2) provider/model resolution that
 * honours the specialist record's `provider`/`model` (used here for the
 * pre-flight key check; `specialistDefinition.resolveModel` re-runs the same
 * resolution inside `runDefinition`), (3) the concurrency-pool slot dance,
 * and (4) construction of the per-call `PlanStore` shared between the `plan`
 * tool and the ReAct enforcement loop's strategy context. Everything else —
 * persona composition, tool set, step budget, hooks, ReAct strategy — lives
 * on `specialistDefinition`.
 *
 * @param ctx - Assembled AgentContext (config, stores, mcp, toolOptions, optional RAG).
 */
export function createSpecialistRunTool(ctx: AgentContext): Tool {
  registerBuiltinDefinitions();
  const { config } = ctx;
  const specialistStore = ctx.stores.specialists;
  return tool({
    description:
      "Invoke a saved specialist agent to handle a task using its custom persona, instructions, and behavioral guidelines. The specialist runs as an independent sub-agent with its own system prompt. Use this when the task matches an existing specialist's domain.",
    parameters: z.object({
      specialistId: z.string().describe('The ID of the specialist to invoke (e.g. "email-triage")'),
      task: z
        .string()
        .describe(
          'A detailed, self-contained task description. Include: (1) specific objective and expected output format, (2) exact file paths, commands, or URLs, (3) edge cases and what to do if something fails. The specialist has zero prior context beyond its own profile.',
        ),
      context: z.string().optional().describe('Optional additional context to help the specialist'),
      provider: z
        .string()
        .optional()
        .describe(
          'Optional provider override for this invocation (e.g. "xai"). Takes priority over specialist config and global config.',
        ),
      model: z
        .string()
        .optional()
        .describe(
          'Optional model override for this invocation (e.g. "grok-code-fast-1"). Takes priority over specialist config and global config.',
        ),
    }),
    execute: async ({ specialistId, task, context, provider, model }, execOptions) => {
      const specialist = specialistStore.get(specialistId);
      if (!specialist) {
        return `Error: No specialist found with id "${specialistId}". Use the specialist tool to list or create specialists.`;
      }
      if (specialist.disabled) {
        return `Error: Specialist "${specialistId}" is disabled. Re-enable it from the /specialists menu before invoking it.`;
      }

      const resolution = resolveProviderAndModel({
        provider,
        model,
        specialistProvider: specialist.provider,
        specialistModel: specialist.model,
        config,
      });
      if (!resolution.ok) {
        return `Error: ${defaultProviderErrorMessage(resolution.provider, resolution.envVar, resolution.isCustom)}`;
      }

      return withSlot(
        async (slot) => {
          const id = slot.id;
          printSpecialistStart(id, specialist.name, task);

          // Per-run plan store: shared between the `plan` tool the definition
          // mounts and the strategy context the ReAct enforcement loop reads.
          const planStore = new PlanStore();

          try {
            const def = definitions.get<SpecialistInput, string>('specialist');
            const input: SpecialistInput = context
              ? { specialistId, task, context, slotId: id, planStore }
              : { specialistId, task, slotId: id, planStore };
            const { formatted } = await runDefinition(ctx, def, input, {
              abortSignal: execOptions.abortSignal,
              overrides: { provider, model },
              planStore,
            });
            printSpecialistEnd(id);
            return formatted;
          } catch (err: unknown) {
            printSpecialistEnd(id);
            const message = err instanceof Error ? err.message : String(err);
            return `Specialist error: ${message}`;
          }
        },
        () =>
          `Error: Maximum concurrent agents (${getMaxConcurrentAgents()}) reached. Wait for existing agents to finish.`,
      );
    },
  });
}

// Re-export the definition for direct access (tests, future internal callers).
export { specialistDefinition };
