import { generateText, tool } from 'ai';
import { z } from 'zod';
import { getModelForConfig, getProviderOptionsForConfig } from '../providers/index.js';
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
import { type BernardConfig, resolveProviderAndModel } from '../config.js';
import type { MemoryStore } from '../memory.js';
import type { RAGStore } from '../rag.js';
import { RoutineStore } from '../routines.js';
import type { Specialist, SpecialistStore } from '../specialists.js';
import { CandidateStore, type CandidateStoreReader } from '../specialist-candidates.js';
import type { CorrectionCandidateStore } from '../correction-candidates.js';
import { ToolProfileStore } from '../tool-profiles.js';
import type { AgentContext } from '../framework/context.js';
import { osPromptBlock } from '../os-info.js';
import {
  STRUCTURED_OUTPUT_RULES,
  wrapWrapperResult,
  type WrapperResult,
} from '../structured-output.js';
import { appendReasoningLog } from '../reasoning-log.js';
import { capSubagentResult, SUBAGENT_RESULT_MAX_CHARS } from './result-cap.js';

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

/** Dependencies that change per-process but never per-call. Passed once. */
export interface ToolWrapperDeps {
  config: BernardConfig;
  options: ToolOptions;
  memoryStore: MemoryStore;
  specialistStore: SpecialistStore;
  correctionStore: CorrectionCandidateStore;
  mcpTools?: Record<string, any>;
  ragStore?: RAGStore;
  routineStore?: RoutineStore;
  candidateStore?: CandidateStoreReader;
  toolProfileStore?: ToolProfileStore;
}

/** Derives the legacy {@link ToolWrapperDeps} shape from an {@link AgentContext}. */
export function ctxToToolWrapperDeps(ctx: AgentContext): ToolWrapperDeps {
  return {
    config: ctx.config,
    options: ctx.toolOptions,
    memoryStore: ctx.stores.memory,
    specialistStore: ctx.stores.specialists,
    correctionStore: ctx.stores.correction,
    mcpTools: ctx.mcp.tools,
    ragStore: ctx.rag,
    routineStore: ctx.stores.routines,
    candidateStore: ctx.stores.candidates,
    toolProfileStore: ctx.stores.toolProfiles,
  };
}

/** Lifts {@link ToolWrapperDeps} into a full {@link AgentContext} for child factories. */
export function depsToCtx(deps: ToolWrapperDeps): AgentContext {
  return {
    config: deps.config,
    stores: {
      memory: deps.memoryStore,
      routines: deps.routineStore ?? new RoutineStore(),
      specialists: deps.specialistStore,
      candidates: deps.candidateStore ?? new CandidateStore(),
      correction: deps.correctionStore,
      toolProfiles: deps.toolProfileStore ?? new ToolProfileStore(),
    },
    mcp: { tools: deps.mcpTools ?? {}, serverNames: [] },
    rag: deps.ragStore,
    toolOptions: deps.options,
  };
}

/** Per-call inputs to a tool-wrapper dispatch. */
export interface DispatchToolWrapperArgs {
  specialistId: string;
  input: string;
  context?: string;
  provider?: string;
  model?: string;
  abortSignal?: AbortSignal;
  /** Label shown to the user when announcing the wrapper run. Defaults to `[<kind>] <name>`. */
  runLabel?: string;
}

/**
 * Core dispatch for tool-wrapper specialists. Used by both the explicit
 * `tool_wrapper_run` tool and the shim layer that routes raw tool calls
 * (e.g. `shell`) through their corresponding wrapper specialist.
 *
 * Returns a {@link WrapperResult} so callers can shape the parent-facing
 * response however they like (JSON envelope, raw result, error string).
 * Pool acquisition, reasoning logging, and correction-candidate enqueue
 * happen inside.
 */
export async function dispatchToolWrapper(
  args: DispatchToolWrapperArgs,
  deps: ToolWrapperDeps,
): Promise<WrapperResult> {
  const { specialistId, input, context, provider, model, abortSignal, runLabel } = args;
  const {
    config,
    options,
    memoryStore,
    specialistStore,
    correctionStore,
    mcpTools,
    routineStore,
    candidateStore,
  } = deps;

  const specialist = specialistStore.get(specialistId);
  if (!specialist) {
    return {
      status: 'error',
      result: `No specialist found with id "${specialistId}".`,
      error: 'not_found',
    };
  }
  const kind = specialist.kind ?? 'persona';
  if (kind === 'persona') {
    return {
      status: 'error',
      result: `Specialist "${specialistId}" is a persona specialist. Use specialist_run instead, or update its kind to "tool-wrapper".`,
      error: 'wrong_kind',
    };
  }

  const resolution = resolveProviderAndModel({
    provider,
    model,
    specialistProvider: specialist.provider,
    specialistModel: specialist.model,
    config,
  });
  if (!resolution.ok) {
    const hint = resolution.isCustom
      ? `Run: bernard add-key ${resolution.provider} <key>`
      : `Set ${resolution.envVar} or run: bernard add-key ${resolution.provider} <key>`;
    return {
      status: 'error',
      result: `No API key for provider "${resolution.provider}". ${hint}.`,
      error: 'no_api_key',
    };
  }
  const { provider: resolvedProvider, model: resolvedModel } = resolution;

  const slot = acquireSlot();
  if (!slot) {
    return {
      status: 'error',
      result: `Maximum concurrent agents (${MAX_CONCURRENT_AGENTS}) reached.`,
      error: 'pool_exhausted',
    };
  }

  const id = slot.id;
  const prefix = `wrap:${id}`;
  const label = runLabel ?? `[${kind}] ${specialist.name}`;
  printSpecialistStart(id, label, input);

  try {
    const baseTools = createTools(
      options,
      memoryStore,
      mcpTools,
      routineStore,
      specialistStore,
      candidateStore,
      config,
    );
    const innerCtx = depsToCtx(deps);
    const fullRegistry: Record<string, any> = {
      ...baseTools,
      agent: createSubAgentTool(innerCtx),
      task: createTaskTool(innerCtx),
      specialist_run: createSpecialistRunTool(innerCtx),
      tool_wrapper_run: createToolWrapperRunTool(innerCtx),
    };
    const childTools = buildChildTools(specialist, fullRegistry);

    let systemPrompt = specialist.systemPrompt;
    if (specialist.guidelines.length > 0) {
      systemPrompt += '\n\nGuidelines:\n' + specialist.guidelines.map((g) => `- ${g}`).join('\n');
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

    // Lazy import to avoid a top-level cycle (tool-call-repair → providers).
    const { makeRepairHook } = await import('../tool-call-repair.js');
    const repairHook = makeRepairHook({
      config,
      provider: resolvedProvider,
      model: resolvedModel,
      label: 'tool-wrapper',
      abortSignal,
    });

    const result = await generateText({
      model: getModelForConfig(config, resolvedProvider, resolvedModel),
      providerOptions: getProviderOptionsForConfig(config, resolvedProvider),
      tools: childTools,
      maxSteps,
      maxTokens: config.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      abortSignal,
      experimental_prepareStep: wantStructured ? makeLastStepTextOnly(maxSteps) : undefined,
      experimental_repairToolCall: repairHook,
      onStepFinish,
    });

    printSpecialistEnd(id);

    const wrapped = wantStructured
      ? wrapWrapperResult(result.text)
      : { status: 'ok' as const, result: result.text };

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

    return wrapped;
  } catch (err: unknown) {
    printSpecialistEnd(id);
    const message = err instanceof Error ? err.message : String(err);
    appendReasoningLog({
      ts: new Date().toISOString(),
      specialistId,
      input,
      toolCalls: [],
      finalOutput: message,
      status: 'error',
      error: 'runtime_error',
    });
    return { status: 'error', result: message, error: 'runtime_error' };
  } finally {
    releaseSlot();
  }
}

/**
 * Strips internal fields (`reasoning`) from a wrapper result before it crosses
 * back into the parent agent's context, and caps the `result` field so the
 * outer JSON envelope stays parseable when the wrapper output is large. The
 * reasoning array is already persisted to the JSONL trace via
 * {@link appendReasoningLog}; the parent doesn't need it.
 *
 * The cap is applied to the `result` field *before* serialization rather than
 * to the serialized envelope, so a truncated payload never produces invalid
 * JSON.
 */
export function renderWrapperParentView(
  wrapped: WrapperResult,
  maxChars: number = SUBAGENT_RESULT_MAX_CHARS,
): string {
  const errorLen = wrapped.error?.length ?? 0;
  const resultBudget = Math.max(256, maxChars - errorLen - 80);

  const cappedResult =
    typeof wrapped.result === 'string'
      ? capSubagentResult(wrapped.result, resultBudget)
      : (() => {
          const asJson = JSON.stringify(wrapped.result);
          if (asJson === undefined || asJson.length <= resultBudget) return wrapped.result;
          return capSubagentResult(asJson, resultBudget);
        })();

  const parentView =
    wrapped.status === 'ok'
      ? { status: 'ok' as const, result: cappedResult }
      : {
          status: 'error' as const,
          result: cappedResult,
          ...(wrapped.error !== undefined ? { error: wrapped.error } : {}),
        };
  return JSON.stringify(parentView);
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
 *   - strips `reasoning` and caps the JSON envelope before returning to the
 *     parent agent — the full reasoning lives in the JSONL trace only
 */
export function createToolWrapperRunTool(ctx: AgentContext) {
  const deps = ctxToToolWrapperDeps(ctx);
  return tool({
    description:
      'Dispatch to a saved tool-wrapper specialist that handles a concrete tool or CLI (e.g. shell-wrapper, file-wrapper). Returns JSON {status, result, error?}. Use this for tool-heavy operations where domain-specific examples and error handling reduce misuse. Also used to invoke meta specialists (specialist-creator, correction-agent).',
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
        .optional()
        .describe('Optional additional context (file paths, prior findings, constraints).'),
      provider: z.string().optional().describe('Optional provider override for this invocation.'),
      model: z.string().optional().describe('Optional model override for this invocation.'),
    }),
    execute: async ({ specialistId, input, context, provider, model }, execOptions) => {
      const wrapped = await dispatchToolWrapper(
        {
          specialistId,
          input,
          context,
          provider,
          model,
          abortSignal: execOptions.abortSignal,
        },
        deps,
      );
      return renderWrapperParentView(wrapped);
    },
  });
}
