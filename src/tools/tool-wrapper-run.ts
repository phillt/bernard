import { generateText, tool } from 'ai';
import { z } from 'zod';
import { getModel, getProviderOptions } from '../providers/index.js';
import { createTools, type ToolOptions } from './index.js';
import { createSubAgentTool } from './subagent.js';
import { createTaskTool } from './task.js';
import { createSpecialistRunTool } from './specialist-run.js';
import { makeLastStepTextOnly } from './task.js';
import {
  printSpecialistStart,
  printSpecialistEnd,
  printToolCall,
  printToolResult,
  printAssistantText,
} from '../output.js';
import { debugLog } from '../logger.js';
import { buildMemoryContext } from '../memory-context.js';
import { acquireSlot, releaseSlot, MAX_CONCURRENT_AGENTS } from './agent-pool.js';
import {
  type BernardConfig,
  hasProviderKey,
  getDefaultModel,
  PROVIDER_ENV_VARS,
} from '../config.js';
import type { MemoryStore } from '../memory.js';
import type { RAGStore } from '../rag.js';
import type { RoutineStore } from '../routines.js';
import type { SpecialistStore, Specialist } from '../specialists.js';
import type { CandidateStoreReader } from '../specialist-candidates.js';
import type { CorrectionCandidateStore } from '../correction-candidates.js';
import { osPromptBlock } from '../os-info.js';
import { STRUCTURED_OUTPUT_RULES, wrapWrapperResult } from '../structured-output.js';
import { appendReasoningLog } from '../reasoning-log.js';

/** Fraction of config.maxSteps allocated to a tool-wrapper run. Mirrors task/specialist ratios. */
const TOOL_WRAPPER_STEP_RATIO = 0.5;

/** Formats good/bad examples as a markdown block appended to the child's system prompt. */
export function formatExamples(specialist: Specialist): string {
  const parts: string[] = [];
  const good = specialist.goodExamples ?? [];
  const bad = specialist.badExamples ?? [];
  if (good.length > 0) {
    parts.push('\n\n## Good Examples (follow these patterns)');
    for (const ex of good) {
      parts.push(`\n- Input: ${ex.input}\n  Call: ${ex.call}`);
      if (ex.note) parts.push(`\n  Note: ${ex.note}`);
    }
  }
  if (bad.length > 0) {
    parts.push('\n\n## Bad Examples (AVOID these patterns)');
    for (const ex of bad) {
      parts.push(
        `\n- Input: ${ex.input}\n  Bad call: ${ex.call}\n  Error observed: ${ex.error}\n  Correct approach: ${ex.fix}`,
      );
      if (ex.note) parts.push(`\n  Note: ${ex.note}`);
    }
  }
  return parts.join('');
}

/**
 * Builds the full tool registry a tool-wrapper specialist could possibly
 * reach, then intersects with `targetTools` when set. Persona/tool-wrapper
 * specialists get strict isolation; meta specialists typically pass
 * `targetTools` that include dispatch tools (specialist, tool_wrapper_run)
 * for recursive orchestration.
 */
export function buildChildTools(
  specialist: Specialist,
  fullRegistry: Record<string, any>,
): Record<string, any> {
  const targets = specialist.targetTools;
  if (!targets || targets.length === 0) {
    // No filter specified — expose everything. Common for meta specialists.
    return fullRegistry;
  }
  const filtered: Record<string, any> = {};
  for (const name of targets) {
    if (fullRegistry[name]) filtered[name] = fullRegistry[name];
  }
  return filtered;
}

/**
 * Captures the last tool call observed in a `generateText` result.
 * Used to populate `attemptedCall` on correction candidates.
 */
export function captureLastToolCall(steps: any[] | undefined): string {
  if (!steps || steps.length === 0) return '(no tool call)';
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const calls = step?.toolCalls ?? [];
    if (calls.length > 0) {
      const tc = calls[calls.length - 1];
      try {
        return `${tc.toolName} ${JSON.stringify(tc.args).slice(0, 600)}`;
      } catch {
        return `${tc.toolName} (unserializable args)`;
      }
    }
  }
  return '(no tool call)';
}

/**
 * Builds a compact record of tool calls for the reasoning log.
 */
export function captureToolCalls(steps: any[] | undefined): Array<{
  tool: string;
  args: unknown;
  resultPreview: string;
}> {
  if (!steps) return [];
  const out: Array<{ tool: string; args: unknown; resultPreview: string }> = [];
  for (const step of steps) {
    const calls = step?.toolCalls ?? [];
    const results = step?.toolResults ?? [];
    for (let i = 0; i < calls.length; i++) {
      const tc = calls[i];
      const tr = results[i];
      const resultText = tr?.result === undefined ? '' : String(tr.result);
      out.push({
        tool: tc.toolName,
        args: tc.args,
        resultPreview: resultText.slice(0, 300),
      });
    }
  }
  return out;
}

/**
 * Creates the `tool_wrapper_run` tool for structured, isolated tool-wrapper
 * specialist execution with validated JSON output and failure-learning.
 *
 * Unlike `specialist_run` (plain-text persona execution), this dispatch:
 *   - only runs specialists with `kind` in `'tool-wrapper' | 'meta'`
 *   - restricts the child's tool set to the specialist's `targetTools`
 *   - injects OS context + good/bad examples + structured-output rules
 *   - forces a JSON final message via `experimental_prepareStep`
 *   - parses through a Zod schema and logs runs that reach `generateText`
 *     to the reasoning log (guard failures return early without logging)
 *   - enqueues a correction candidate on error for end-of-session learning
 */
export function createToolWrapperRunTool(
  config: BernardConfig,
  options: ToolOptions,
  memoryStore: MemoryStore,
  specialistStore: SpecialistStore,
  correctionStore: CorrectionCandidateStore,
  mcpTools?: Record<string, any>,
  ragStore?: RAGStore,
  routineStore?: RoutineStore,
  candidateStore?: CandidateStoreReader,
) {
  return tool({
    description:
      'Dispatch to a saved tool-wrapper specialist that handles a concrete tool or CLI (e.g. shell-wrapper, file-wrapper). Returns strict JSON {status, result, error?, reasoning?}. Use this for tool-heavy operations where domain-specific examples and error handling reduce misuse. Also used to invoke meta specialists (specialist-creator, correction-agent).',
    parameters: z.object({
      specialistId: z
        .string()
        .describe(
          'The ID of the tool-wrapper or meta specialist to invoke (e.g. "shell-wrapper").',
        ),
      input: z
        .string()
        .describe(
          'The natural-language request to hand to the specialist. Be specific — the specialist has no prior context.',
        ),
      context: z
        .string()
        .nullable()
        .describe('Optional additional context (file paths, prior findings, constraints).'),
      provider: z.string().nullable().describe('Optional provider override for this invocation.'),
      model: z.string().nullable().describe('Optional model override for this invocation.'),
    }),
    execute: async ({ specialistId, input, context, provider, model }, execOptions) => {
      const specialist = specialistStore.get(specialistId);
      if (!specialist) {
        return JSON.stringify({
          status: 'error',
          result: `No specialist found with id "${specialistId}".`,
          error: 'not_found',
        });
      }
      const kind = specialist.kind ?? 'persona';
      if (kind === 'persona') {
        return JSON.stringify({
          status: 'error',
          result: `Specialist "${specialistId}" is a persona specialist. Use specialist_run instead, or update its kind to "tool-wrapper".`,
          error: 'wrong_kind',
        });
      }

      const resolvedProvider = provider ?? specialist.provider ?? config.provider;
      const explicitModel = model ?? specialist.model;
      const resolvedModel =
        explicitModel ??
        (resolvedProvider !== config.provider ? getDefaultModel(resolvedProvider) : config.model);

      if (!hasProviderKey(config, resolvedProvider)) {
        const envVar =
          PROVIDER_ENV_VARS[resolvedProvider] ?? `${resolvedProvider.toUpperCase()}_API_KEY`;
        return JSON.stringify({
          status: 'error',
          result: `No API key for provider "${resolvedProvider}". Set ${envVar} or run: bernard add-key ${resolvedProvider} <key>.`,
          error: 'no_api_key',
        });
      }

      const slot = acquireSlot();
      if (!slot) {
        return JSON.stringify({
          status: 'error',
          result: `Maximum concurrent agents (${MAX_CONCURRENT_AGENTS}) reached.`,
          error: 'pool_exhausted',
        });
      }

      const id = slot.id;
      const prefix = `wrap:${id}`;
      const runLabel = `[${kind}] ${specialist.name}`;
      printSpecialistStart(id, runLabel, input);

      try {
        // Base tools + dispatch tools so meta specialists can nest properly.
        const baseTools = createTools(
          options,
          memoryStore,
          mcpTools,
          routineStore,
          specialistStore,
          candidateStore,
          config,
        );
        const fullRegistry: Record<string, any> = {
          ...baseTools,
          agent: createSubAgentTool(config, options, memoryStore, mcpTools, ragStore),
          task: createTaskTool(config, options, memoryStore, mcpTools, ragStore, routineStore),
          specialist_run: createSpecialistRunTool(
            config,
            options,
            memoryStore,
            specialistStore,
            mcpTools,
            ragStore,
          ),
          tool_wrapper_run: createToolWrapperRunTool(
            config,
            options,
            memoryStore,
            specialistStore,
            correctionStore,
            mcpTools,
            ragStore,
            routineStore,
            candidateStore,
          ),
        };
        const childTools = buildChildTools(specialist, fullRegistry);

        // Build system prompt.
        let systemPrompt = specialist.systemPrompt;
        if (specialist.guidelines.length > 0) {
          systemPrompt +=
            '\n\nGuidelines:\n' + specialist.guidelines.map((g) => `- ${g}`).join('\n');
        }
        systemPrompt += '\n\n' + osPromptBlock();
        systemPrompt += formatExamples(specialist);
        // Default to structured output for tool-wrapper specialists unless explicitly disabled.
        const wantStructured = specialist.structuredOutput ?? kind === 'tool-wrapper';
        if (wantStructured) {
          systemPrompt += STRUCTURED_OUTPUT_RULES;
        }
        systemPrompt += buildMemoryContext({
          memoryStore,
          ragResults: undefined,
          includeScratch: true,
        });
        if (Object.keys(childTools).length > 0) {
          systemPrompt += `\n\nAvailable tools for this run: ${Object.keys(childTools).join(', ')}`;
        } else {
          systemPrompt +=
            '\n\nNo tools are available for this run. Produce the structured output based on reasoning alone.';
        }

        let userMessage = `Request: ${input}`;
        if (context) userMessage += `\n\nContext: ${context}`;

        const maxSteps = Math.max(2, Math.ceil(config.maxSteps * TOOL_WRAPPER_STEP_RATIO));

        const onStepFinish = ({ text, toolCalls, toolResults }: any) => {
          for (const tc of toolCalls ?? []) {
            printToolCall(tc.toolName, tc.args as Record<string, unknown>, prefix);
          }
          for (const tr of toolResults ?? []) {
            printToolResult(tr.toolName, tr.result, prefix);
          }
          if (text) printAssistantText(text, prefix);
        };

        const result = await generateText({
          model: getModel(resolvedProvider, resolvedModel),
          providerOptions: getProviderOptions(resolvedProvider),
          tools: childTools,
          maxSteps,
          maxTokens: config.maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
          abortSignal: execOptions.abortSignal,
          experimental_prepareStep: wantStructured ? makeLastStepTextOnly(maxSteps) : undefined,
          onStepFinish,
        });

        printSpecialistEnd(id);

        const wrapped = wantStructured
          ? wrapWrapperResult(result.text)
          : { status: 'ok' as const, result: result.text };

        // Reasoning log — always write, even when parsing fails.
        appendReasoningLog({
          ts: new Date().toISOString(),
          specialistId,
          input,
          toolCalls: captureToolCalls(result.steps as any[]),
          finalOutput: wrapped.result,
          status:
            wrapped.status === 'ok'
              ? 'ok'
              : wrapped.error === 'parse_failed'
                ? 'parse_failed'
                : 'error',
          ...(wrapped.error !== undefined ? { error: wrapped.error } : {}),
          ...(wrapped.reasoning !== undefined ? { reasoning: wrapped.reasoning } : {}),
        });

        // Enqueue correction candidate on failure (tool-wrapper only; meta specialists
        // often manage their own error flows and don't benefit from auto-correction).
        if (wrapped.status === 'error' && kind === 'tool-wrapper') {
          try {
            correctionStore.enqueue({
              specialistId,
              input,
              attemptedCall: captureLastToolCall(result.steps as any[]),
              error: wrapped.error ?? String(wrapped.result),
            });
          } catch (err) {
            debugLog(
              'tool-wrapper:correction-enqueue:error',
              err instanceof Error ? err.message : String(err),
            );
          }
        }

        return JSON.stringify(wrapped);
      } catch (err: unknown) {
        printSpecialistEnd(id);
        const message = err instanceof Error ? err.message : String(err);
        const errorResult = { status: 'error' as const, result: message, error: 'runtime_error' };
        appendReasoningLog({
          ts: new Date().toISOString(),
          specialistId,
          input,
          toolCalls: [],
          finalOutput: message,
          status: 'error',
          error: 'runtime_error',
        });
        return JSON.stringify(errorResult);
      } finally {
        releaseSlot();
      }
    },
  });
}
