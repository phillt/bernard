import {
  generateText,
  type CoreMessage,
  type ToolCallRepairFunction,
  type ToolSet,
  NoSuchToolError,
  InvalidToolArgumentsError,
} from 'ai';
import { getModelForConfig, getProviderOptionsForConfig } from './providers/index.js';
import type { BernardConfig } from './config.js';
import type { ModelTier } from './model-policy.js';
import { debugLog, traceLlm } from './logger.js';
import { usageRecordFromSite, type UsageRecorder } from './framework/hooks/token-stats.js';

/** Identifies which generateText site produced the failed tool call. */
export type RepairLabel =
  | 'main'
  | 'specialist'
  | 'subagent'
  | 'tool-wrapper'
  | 'mcp-delegate'
  | 'cron';

export interface MakeRepairHookOpts {
  config: BernardConfig;
  /** Provider to use for the repair call. Defaults to config.provider. */
  provider?: string;
  /** Model to use for the repair call. Defaults to config.model. */
  model?: string;
  label: RepairLabel;
  /** Optional abort signal forwarded to the repair generateText call. */
  abortSignal?: AbortSignal;
  /**
   * Cost tier of the dispatch being repaired, used to bucket the repair call's
   * tokens in telemetry. Undefined → bucketed `pinned`.
   */
  tier?: ModelTier;
  /**
   * Records the repair call's usage into the session telemetry sink (#session-
   * telemetry). A repair re-sends the full message history + tool schemas, so
   * it's a materially-sized billed call that would otherwise be invisible.
   */
  onUsage?: UsageRecorder;
}

/**
 * Heuristic detector for tool-call argument truncation. When the model emits a
 * massive single string argument (e.g. a 16 KB heredoc inside a `command`
 * field), the response may be cut off mid-string, producing
 * "Unterminated string in JSON" or similar from JSON.parse.
 */
function looksLikeTruncationError(message: string): boolean {
  return (
    /unterminated string/i.test(message) ||
    /unexpected end of (json|input)/i.test(message) ||
    /expected.*after.*in json/i.test(message)
  );
}

/**
 * Produces an `experimental_repairToolCall` hook for `generateText`. When the
 * AI SDK fails to parse a model's tool-call arguments (or the model targets a
 * nonexistent tool), the hook runs ONE focused generation asking the model to
 * re-emit a valid tool call. Returns the corrected call, or `null` to let the
 * SDK throw.
 *
 * The repair attempt is bounded to a single retry per failed tool call — no
 * looping, no escalation. Failures are logged to the debug stream.
 *
 * Special-cases JSON truncation (the model packed too much content into a
 * single string arg) by hinting at `file_write` + `shell` as the safe pattern
 * for large payloads.
 */
export function makeRepairHook<TOOLS extends ToolSet>(
  opts: MakeRepairHookOpts,
): ToolCallRepairFunction<TOOLS> {
  const { config, provider, model, label, abortSignal, tier, onUsage } = opts;
  const resolvedProvider = provider ?? config.provider;
  const resolvedModel = model ?? config.model;

  return async ({ toolCall, tools, parameterSchema, messages, system, error }) => {
    try {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isInvalidArgs = InvalidToolArgumentsError.isInstance(error);
      const isNoSuchTool = NoSuchToolError.isInstance(error);

      let hint = '';
      if (isInvalidArgs && toolCall.toolName === 'plan') {
        hint =
          "\n\nThe `plan` tool requires each step's `description` and `verification` to be a single line of plain text with NO newlines of any kind — neither literal line breaks (which JSON forbids inside string values) nor escaped `\\n` sequences. Re-emit the call with short, single-line entries (under ~400 characters each). If a step needs more detail, split it into multiple smaller steps rather than packing a multi-line blob into one entry.";
      } else if (isInvalidArgs && looksLikeTruncationError(errorMessage)) {
        hint =
          '\n\nThe arguments appear to have been truncated mid-string. For payloads larger than ~1 KB (file contents, scripts, JSON bodies), write the content to a file using `file_write` (or save a script with `file_write` and execute it with `shell`) instead of inlining it as a tool-call argument.';
      } else if (isNoSuchTool) {
        const available = Object.keys(tools).slice(0, 25).join(', ');
        hint = `\n\nThe tool "${toolCall.toolName}" does not exist. Available tools include: ${available}.`;
      }

      let schemaText = '';
      try {
        const schema = parameterSchema({ toolName: toolCall.toolName });
        schemaText = `\n\nExpected parameter schema for \`${toolCall.toolName}\`:\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``;
      } catch {
        // No schema available (e.g. unknown tool) — skip.
      }

      const recoveryMessage: CoreMessage = {
        role: 'user',
        content: `Your previous tool call to \`${toolCall.toolName}\` failed to parse:\n\n${errorMessage}${schemaText}${hint}\n\nRe-emit the tool call with valid arguments. Do not explain — just call the tool.`,
      };

      const repairMessages: CoreMessage[] = [...messages, recoveryMessage];

      const repairModel = getModelForConfig(config, resolvedProvider, resolvedModel);
      const repairStartedAt = Date.now();
      const result = await traceLlm(`tool-call-repair:${label}`, repairModel.modelId, () =>
        generateText({
          model: repairModel,
          providerOptions: getProviderOptionsForConfig(config, resolvedProvider),
          tools,
          toolChoice: isNoSuchTool ? 'auto' : { type: 'tool', toolName: toolCall.toolName },
          maxSteps: 1,
          maxTokens: config.maxTokens,
          system,
          messages: repairMessages,
          abortSignal,
        }),
      );
      // Record the repair's token spend (a full-context re-send) regardless of
      // whether it produced a usable call — the tokens were billed either way.
      onUsage?.(
        usageRecordFromSite(
          { tier, provider: resolvedProvider, modelName: resolvedModel },
          'tool-call-repair',
          result.usage,
          result.providerMetadata,
          { latencyMs: Date.now() - repairStartedAt },
        ),
      );

      const repaired = result.toolCalls?.[0];
      if (!repaired) {
        debugLog(`tool-call-repair:${label}:no-call`, {
          toolName: toolCall.toolName,
          errorMessage,
        });
        return null;
      }

      debugLog(`tool-call-repair:${label}:ok`, {
        original: toolCall.toolName,
        repaired: repaired.toolName,
      });

      return {
        toolCallType: 'function',
        toolCallId: toolCall.toolCallId,
        toolName: repaired.toolName,
        args: JSON.stringify(repaired.args),
      };
    } catch (err) {
      debugLog(`tool-call-repair:${label}:error`, err instanceof Error ? err.message : String(err));
      return null;
    }
  };
}
