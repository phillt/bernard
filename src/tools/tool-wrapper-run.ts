import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { createTools, type ToolOptions } from './index.js';
import { createSubAgentTool } from './subagent.js';
import { createTaskTool } from './task.js';
import { toolToAISDK } from '../framework/tools/adapter.js';
import { createSpecialistRunTool } from './specialist-run.js';
import { printSpecialistStart, printSpecialistEnd } from '../output.js';
import { debugLog } from '../logger.js';
import { acquireSlot, releaseSlot, MAX_CONCURRENT_AGENTS } from './agent-pool.js';
import { type BernardConfig, resolveProviderAndModel } from '../config.js';
import type { MemoryStore } from '../memory.js';
import type { RAGStore } from '../rag.js';
import { RoutineStore } from '../routines.js';
import type { SpecialistStore } from '../specialists.js';
import { CandidateStore, type CandidateStoreReader } from '../specialist-candidates.js';
import type { CorrectionCandidateStore } from '../correction-candidates.js';
import { ToolProfileStore } from '../tool-profiles.js';
import type { AgentContext } from '../framework/context.js';
import { type WrapperResult } from '../structured-output.js';
import { appendReasoningLog } from '../reasoning-log.js';
import { capSubagentResult, SUBAGENT_RESULT_MAX_CHARS } from './result-cap.js';
import {
  definitions,
  registerBuiltinDefinitions,
  toolWrapperDefinition,
  buildChildTools,
  formatExamples,
  type ToolWrapperInput,
} from '../framework/agents/index.js';
import { runDefinition } from '../framework/agents/run.js';

// Re-export the helpers that other modules (tests, parity scripts) already
// import from this path. Implementations live in `framework/agents/tool-wrapper.ts`.
export { buildChildTools, formatExamples };

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
 * The early guards (missing specialist, wrong kind, missing API key, pool
 * exhausted) all return early without ever entering the framework. Once the
 * pool slot is acquired, the call passes through `runDefinition(... 'tool-wrapper' ...)`;
 * the cross-cutting concerns that don't fit the definition shape — reasoning
 * log append, correction-candidate enqueue, the parent-facing
 * {@link WrapperResult} — stay here.
 */
export async function dispatchToolWrapper(
  args: DispatchToolWrapperArgs,
  deps: ToolWrapperDeps,
): Promise<WrapperResult> {
  registerBuiltinDefinitions();
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

  const slot = acquireSlot();
  if (!slot) {
    return {
      status: 'error',
      result: `Maximum concurrent agents (${MAX_CONCURRENT_AGENTS}) reached.`,
      error: 'pool_exhausted',
    };
  }

  const id = slot.id;
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
    const fullRegistry: Record<string, Tool> = {
      ...baseTools,
      agent: createSubAgentTool(innerCtx),
      task: toolToAISDK(createTaskTool(innerCtx)),
      specialist_run: createSpecialistRunTool(innerCtx),
      tool_wrapper_run: createToolWrapperRunTool(innerCtx),
    };
    const childTools = buildChildTools(specialist, fullRegistry);
    const wantStructured = specialist.structuredOutput ?? kind === 'tool-wrapper';

    const def = definitions.get<ToolWrapperInput, WrapperResult>('tool-wrapper');
    const defInput: ToolWrapperInput = context
      ? {
          specialistId,
          input,
          context,
          slotId: id,
          childTools,
          wantStructured,
        }
      : {
          specialistId,
          input,
          slotId: id,
          childTools,
          wantStructured,
        };
    const { result, formatted: wrapped } = await runDefinition(innerCtx, def, defInput, {
      abortSignal,
      overrides: { provider, model },
    });

    printSpecialistEnd(id);

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
 * outer JSON envelope stays parseable when the wrapper output is large.
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

export { toolWrapperDefinition };
