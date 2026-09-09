import { tool, type Tool } from 'ai';
import { invocationRefusal } from '../specialist-authority.js';
import { attachmentsArg, resolveAttachments } from './attachment-args.js';
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
import {
  withSlot,
  getMaxConcurrentAgents,
  slotStatusLine,
  dispatchDepth,
  MAX_DISPATCH_DEPTH,
} from './agent-pool.js';
import { debugLog } from '../logger.js';
import { runDispatchOrFail } from './dispatch-failure.js';

/**
 * Creates the specialist execution tool for running tasks through a saved
 * specialist profile.
 *
 * The dispatch wrapper owns four concerns no generic dispatch factory could:
 * (1) the specialist-existence check (so a missing id returns a friendly error
 * before any LLM call), (2) provider/model resolution that honours the
 * specialist record's `provider`/`model` (used here for the pre-flight key
 * check; `specialistDefinition.resolveModel` re-runs the same resolution inside
 * `runDefinition`), (3) the concurrency-pool slot dance, and (4) construction of
 * the per-call `PlanStore` shared between the `plan` tool and the ReAct
 * enforcement loop's strategy context. Everything else — persona composition,
 * tool set, step budget, hooks, ReAct strategy — lives on
 * `specialistDefinition`. The one thing all five dispatch boundaries DO share is
 * the catch, and that lives in `runDispatchOrFail` (#351); the abandoned,
 * never-called `createDispatchTool` factory it replaces is gone.
 *
 * @param ctx - Assembled AgentContext (config, stores, mcp, toolOptions, optional RAG).
 */
/**
 * @param dispatchTools A thunk returning the four dispatch tools, so a persona
 * can delegate to narrower specialists. Supplied by the caller rather than built
 * here, and that is forced rather than chosen: `specialist_run` must be able to
 * contain `specialist_run`, so *something* has to be lazy, and today
 * `tool-wrapper-run.ts` imports this module while this module imports nothing
 * back — which is the only reason that cycle does not exist. Building the four
 * here would create it, and deferring the import merely converts a load-time
 * cycle into a call-time one, which is #452's deadlock (it hung
 * `specialist.target-tools.test.ts` when tried).
 *
 * So the overlay comes from the two places that already construct all four
 * without a cycle: `main.ts` and `tool-wrapper-run.ts`. A **thunk**, because
 * `main.ts` builds its overlay in the same object literal that calls this.
 *
 * **Omission is the safe answer** — a caller that passes nothing dispatches a
 * leaf, which is what every persona was before this. Deliberately NOT extracted
 * into a shared `buildCtxTools(ctx)`: `main.ts`'s overlay carries a
 * styling-capable `applet` and the others must not, and CLAUDE.md records that
 * a shared builder is exactly what recreates that recursion.
 */
export function createSpecialistRunTool(
  ctx: AgentContext,
  dispatchTools?: () => Record<string, Tool>,
): Tool {
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
      attachments: attachmentsArg,

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
    execute: async ({ specialistId, task, context, attachments, provider, model }, execOptions) => {
      const loaded = resolveAttachments(attachments);
      if (!loaded.ok) return `Error: ${loaded.error}`;
      const specialist = specialistStore.get(specialistId);
      if (!specialist) {
        return `Error: No specialist found with id "${specialistId}". Use the specialist tool to list or create specialists.`;
      }
      // Disabled, or bound to an applet action — one decision, in
      // `specialist-authority.ts`; only the error SHAPE is this tool's.
      const refusal = invocationRefusal(specialist, { kind: 'tool' });
      if (refusal) return `Error: ${refusal.message}`;

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

      // Slot status is appended AFTER `withSlot` resolves, so this dispatch's
      // own slot is already released and the count describes what the model can
      // do next rather than what it could do mid-flight.
      const out = await withSlot(
        async (slot) => {
          const id = slot.id;
          printSpecialistStart(id, specialist.name, task);

          // Per-run plan store: shared between the `plan` tool the definition
          // mounts and the strategy context the ReAct enforcement loop reads.
          const planStore = new PlanStore();

          // A cancelled dispatch unwinds; a failed one is a tool result (#327,
          // #351 — the try/catch/re-throw is `runDispatchOrFail`'s).
          return runDispatchOrFail(
            async () => {
              try {
                const def = definitions.get<SpecialistInput, string>('specialist');
                // Built HERE, inside the slot, so `dispatchDepth()` reports this
                // dispatch's own depth — at construction time it would report
                // the parent's, once, and bound nothing.
                //
                // Construction-time filtering rather than a refusal at call
                // time: a tool that was never built needs no error worded across
                // the four dispatch tools' four different return contracts, and
                // there is no gate a fifth caller can forget to consult. The
                // pool does NOT bound this — an acquire from inside a slot
                // holder is free, so nesting passes straight through the cap.
                const depth = dispatchDepth();
                const canDelegate = depth < MAX_DISPATCH_DEPTH;
                if (!canDelegate) {
                  debugLog('specialist:delegation-depth-reached', {
                    specialistId,
                    depth,
                    max: MAX_DISPATCH_DEPTH,
                  });
                }
                const input: SpecialistInput = {
                  specialistId,
                  task,
                  ...(context ? { context } : {}),
                  attachments: loaded.read(),
                  slotId: id,
                  planStore,
                  ...(canDelegate && dispatchTools ? { dispatchTools: dispatchTools() } : {}),
                };
                const { formatted } = await runDefinition(ctx, def, input, {
                  abortSignal: execOptions.abortSignal,
                  overrides: { provider, model },
                  planStore,
                  // Attribute this dispatch's spend to its own per-specialist
                  // site (#299, #508), the way `tool_wrapper_run` has since
                  // #299 and `delegate_<server>` does with `mcp:<server>`.
                  // Without it every specialist folded into the `main` layer of
                  // `bernard usage`, so the one number that could tell you a
                  // persona was expensive said "the main agent is expensive".
                  telemetrySite: `specialist:${specialistId}`,
                });
                return formatted;
              } finally {
                // Every exit path, cancellation included — which is what the
                // success/catch pair it replaces already did, by duplication.
                printSpecialistEnd(id);
              }
            },
            // The `Error:` prefix is load-bearing, not decoration: it is what
            // `detectResultFailure` reads (#364). Without it this failure
            // registers as citable evidence and bumps this tool's successCount.
            (message) => `Error: Specialist "${specialistId}" failed: ${message}`,
          );
        },
        () =>
          `Error: Maximum concurrent agents (${getMaxConcurrentAgents()}) reached. Wait for existing agents to finish.`,
      );
      return `${out}\n${slotStatusLine()}`;
    },
  });
}

// Re-export the definition for direct access (tests, future internal callers).
export { specialistDefinition };
