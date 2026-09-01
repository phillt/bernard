import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { createTools } from './index.js';
import { resolveProviderAndModel } from '../config.js';
import { createSubAgentTool } from './subagent.js';
import { createTaskTool } from './task.js';
import { toolToAISDK, attachMeta, readToolMeta } from '../framework/tools/adapter.js';
import { redactArgs, REDACTED } from '../framework/tools/redact.js';
import { createSpecialistRunTool } from './specialist-run.js';
import { printSpecialistStart, printSpecialistEnd } from '../output.js';
import { debugLog } from '../logger.js';
import { withSlot, getMaxConcurrentAgents } from './agent-pool.js';
import { runDispatchOrFail } from './dispatch-failure.js';
import type { AgentContext } from '../framework/context.js';
import { type WrapperResult } from '../structured-output.js';
import { appendReasoningLog } from '../reasoning-log.js';
import { capSubagentResult, SUBAGENT_RESULT_MAX_CHARS } from './result-cap.js';
import { classifyError } from '../error-taxonomy.js';
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

/** Max characters of a tool result retained in the reasoning log. */
const RESULT_PREVIEW_MAX_CHARS = 300;

/**
 * Renders a tool result for the reasoning log (#343).
 *
 * Was `String(value)`, which yields `"[object Object]"` for the majority of
 * Bernard tools — `shell` returns `{output, is_error}`, the file tools return
 * objects, MCP returns `{content:[…]}`. The one field recording what a tool
 * actually returned carried no information, in the log whose stated purpose is
 * post-hoc triage.
 *
 * **Bounded, because the inputs are not.** `shell` runs with a 10 MB
 * `maxBuffer` and caps nothing on the way out, and `file_read_lines` reads up
 * to `MAX_FILE_SIZE`. A plain `JSON.stringify` of a 10 MB result to keep 300
 * bytes measured 38 ms and ~20 MB of transient allocation, synchronously, on
 * every tool call the shim routes — where `String()` had been free. The
 * replacer truncates long strings during serialization instead, which measures
 * at 0 ms on the same input and renders identically at this preview length.
 *
 * The `try`/`catch` is load-bearing rather than defensive: `JSON.stringify`
 * throws on cycles and BigInt, `appendReasoningLog` is documented as never
 * throwing, and AI SDK results are `any`. Same idiom as `mcp-result-shaper.ts`.
 */
function previewOfResult(value: unknown): string {
  if (value === undefined) return '';
  let text: string;
  try {
    text =
      JSON.stringify(value, (_key, v: unknown) =>
        typeof v === 'string' && v.length > RESULT_PREVIEW_MAX_CHARS
          ? v.slice(0, RESULT_PREVIEW_MAX_CHARS)
          : v,
      ) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.slice(0, RESULT_PREVIEW_MAX_CHARS);
}

/**
 * Builds a compact record of tool calls for the reasoning log.
 *
 * When a `toolRegistry` is provided, each call's args and result preview are
 * scrubbed against the tool's `ToolMeta.sensitiveArgs` / `sensitiveResult`
 * fields before persistence.
 */
export function captureToolCalls(
  steps: any[] | undefined,
  toolRegistry?: Record<string, unknown>,
): Array<{
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
      const meta = toolRegistry ? readToolMeta(toolRegistry[tc.toolName]) : undefined;
      out.push({
        tool: tc.toolName,
        args: meta ? redactArgs(tc.args, meta.sensitiveArgs) : tc.args,
        // Short-circuit BEFORE serializing: a redacted preview was previously
        // computed and thrown away, which now means materializing a
        // secret-bearing payload into a transient string for no reason.
        resultPreview: meta?.sensitiveResult ? REDACTED : previewOfResult(tr?.result),
      });
    }
  }
  return out;
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
  /**
   * When true, errors from this dispatch are NOT enqueued onto the
   * correction-candidate queue. Used by the orchestrator's re-validation pass
   * in `correction.ts` so a failed re-run doesn't recursively spawn a new
   * candidate — the original candidate is already being handled.
   */
  skipCorrectionEnqueue?: boolean;
}

/**
 * Core dispatch for tool-wrapper specialists. Used by both the explicit
 * `tool_wrapper_run` tool and the shim layer that routes raw tool calls
 * (e.g. `shell`) through their corresponding wrapper specialist.
 *
 * The early guards (missing specialist, wrong kind, missing API key) all return
 * without ever entering the framework, as does a full pool. Otherwise the call
 * passes through `runDefinition(... 'tool-wrapper' ...)`;
 * the cross-cutting concerns that don't fit the definition shape — reasoning
 * log append, correction-candidate enqueue, the parent-facing
 * {@link WrapperResult} — stay here.
 */
export async function dispatchToolWrapper(
  args: DispatchToolWrapperArgs,
  ctx: AgentContext,
): Promise<WrapperResult> {
  registerBuiltinDefinitions();
  const {
    specialistId,
    input,
    context,
    provider,
    model,
    abortSignal,
    runLabel,
    skipCorrectionEnqueue,
  } = args;
  const { config, toolOptions: options, stores } = ctx;
  const { specialists: specialistStore, correction: correctionStore } = stores;

  const specialist = specialistStore.get(specialistId);
  if (!specialist) {
    return {
      status: 'error',
      result: `No specialist found with id "${specialistId}".`,
      error: 'not_found',
    };
  }
  if (specialist.disabled) {
    return {
      status: 'error',
      result: `Specialist "${specialistId}" is disabled. Re-enable it from the /specialists menu before invoking it.`,
      error: 'disabled',
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

  return withSlot(
    async (slot): Promise<WrapperResult> => {
      const id = slot.id;
      const label = runLabel ?? `[${kind}] ${specialist.name}`;
      printSpecialistStart(id, label, input);

      // A cancelled dispatch unwinds; a failed one is a tool result (#327,
      // #351 — the try/catch/re-throw is `runDispatchOrFail`'s).
      return runDispatchOrFail(
        async (): Promise<WrapperResult> => {
          try {
            // The FULL surface, read from the definition's own `toolSurface`
            // declaration rather than hardcoded (#253, #322) — so the reason lives in
            // one place and this call can't drift from it. Wrapper specialists are
            // scoped by `targetTools`, and three bundled ones target tools the worker
            // surface removes: `mcp-manager` needs `mcp_config` / `mcp_add_url` /
            // `mcp_verify`, and `correction-agent` / `specialist-creator` need
            // `specialist`. Narrowing here would break them.
            //
            // MCP stays the RAW bag, deliberately, and is the one dispatch that does
            // not take `surface.mcpTools`: `buildChildTools` filters this registry by
            // `specialist.targetTools`, which names real MCP tools, and delegates would
            // make those names unresolvable. Safe since #331, because an unscoped
            // specialist now gets NO tools rather than all of them.
            const baseTools = createTools(
              options,
              stores.memory,
              ctx.mcp.tools,
              stores.routines,
              specialistStore,
              stores.candidates,
              config,
              ctx.provenance,
              { surface: toolWrapperDefinition.toolSurface },
            );
            const fullRegistry: Record<string, Tool> = {
              ...baseTools,
              agent: createSubAgentTool(ctx),
              task: toolToAISDK(createTaskTool(ctx)),
              specialist_run: createSpecialistRunTool(ctx),
              tool_wrapper_run: createToolWrapperRunTool(ctx),
            };
            const childTools = buildChildTools(specialist, fullRegistry, ctx.mcp.resolveAlias);
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
            // `stepLimitHit` is no longer consumed here: `toolWrapperDefinition`
            // receives it directly as `FormatMeta` and does the re-label itself
            // (#370), so `formatted` already carries the right verdict. Reading it
            // back out of the payload — which is what the deleted
            // `reclassifyStepLimit` did — meant inferring a dispatch fact from a
            // model-written error string.
            const { result, formatted: wrapped } = await runDefinition(ctx, def, defInput, {
              abortSignal,
              overrides: { provider, model },
              // Attribute this dispatch's spend to its own per-target site (#299) so it
              // stops folding into the `main` layer. (Per-server MCP delegation has its
              // own dispatch in `src/tools/delegate.ts` and labels `mcp:<server>` there.)
              telemetrySite: `tool-wrapper:${specialistId}`,
            });

            appendReasoningLog({
              ts: new Date().toISOString(),
              specialistId,
              input,
              toolCalls: captureToolCalls(result.steps as any[], childTools),
              finalOutput: wrapped.result,
              // Mirrors `error` rather than re-deriving it per label — a ternary
              // per label is an edit here for every new one.
              status: wrapped.status === 'ok' ? 'ok' : (wrapped.error ?? 'error'),
              ...(wrapped.error !== undefined ? { error: wrapped.error } : {}),
              ...(wrapped.reasoning !== undefined ? { reasoning: wrapped.reasoning } : {}),
            });

            if (wrapped.status === 'error' && kind === 'tool-wrapper' && !skipCorrectionEnqueue) {
              try {
                const errorMessage = wrapped.error ?? String(wrapped.result);
                const attemptedCall = captureLastToolCall(result.steps as any[]);
                // The first targetTool is the canonical tool this wrapper fronts;
                // it lets the classifier distinguish shell "command not found"
                // (correctable) from web 404 (not).
                const wrappedToolName = specialist.targetTools?.[0];
                const cls = classifyError({ message: errorMessage, toolName: wrappedToolName });
                if (cls.correctable) {
                  correctionStore.enqueue({
                    specialistId,
                    input,
                    attemptedCall,
                    error: errorMessage,
                    category: cls.category,
                  });
                } else {
                  debugLog('tool-wrapper:correction-dismiss', {
                    specialistId,
                    category: cls.category,
                  });
                }
              } catch (err) {
                debugLog(
                  'tool-wrapper:correction-enqueue:error',
                  err instanceof Error ? err.message : String(err),
                );
              }
            }

            return wrapped;
          } finally {
            // Every exit path, cancellation included — which is what the
            // success/catch pair it replaces already did, by duplication. It
            // now trails `appendReasoningLog` rather than leading it; both are
            // bookkeeping and `printSpecialistEnd` is a no-op under Ink.
            printSpecialistEnd(id);
          }
        },
        // A `WrapperResult`, not a string: this tool's contract is the
        // `{status, result, error}` envelope the parent agent parses, which is
        // why the shaper is a callback rather than a shared return type.
        (message): WrapperResult => {
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
        },
      );
    },
    (): WrapperResult => ({
      status: 'error',
      result: `Maximum concurrent agents (${getMaxConcurrentAgents()}) reached.`,
      error: 'pool_exhausted',
    }),
  );
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
  return attachMeta(
    tool({
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
          ctx,
        );
        return renderWrapperParentView(wrapped);
      },
    }),
    {
      name: 'tool_wrapper_run',
      kind: 'write',
      deterministic: false,
      sideEffect: 'local',
      cacheable: false,
    },
  );
}

export { toolWrapperDefinition };
