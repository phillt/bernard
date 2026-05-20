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
import { debugLog } from './logger.js';

/** Identifies which generateText site produced the failed tool call. */
export type RepairLabel = 'main' | 'specialist' | 'subagent' | 'tool-wrapper' | 'cron';

export interface MakeRepairHookOpts {
  config: BernardConfig;
  /** Provider to use for the repair call. Defaults to config.provider. */
  provider?: string;
  /** Model to use for the repair call. Defaults to config.model. */
  model?: string;
  label: RepairLabel;
  /** Optional abort signal forwarded to the repair generateText call. */
  abortSignal?: AbortSignal;
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
  const { config, provider, model, label, abortSignal } = opts;
  const resolvedProvider = provider ?? config.provider;
  const resolvedModel = model ?? config.model;

  return async ({ toolCall, tools, parameterSchema, messages, system, error }) => {
    try {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isInvalidArgs = InvalidToolArgumentsError.isInstance(error);
      const isNoSuchTool = NoSuchToolError.isInstance(error);

      let hint = '';
      if (isInvalidArgs && looksLikeTruncationError(errorMessage)) {
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

      const result = await generateText({
        model: getModelForConfig(config, resolvedProvider, resolvedModel),
        providerOptions: getProviderOptionsForConfig(config, resolvedProvider),
        tools,
        toolChoice: isNoSuchTool ? 'auto' : { type: 'tool', toolName: toolCall.toolName },
        maxSteps: 1,
        maxTokens: config.maxTokens,
        system,
        messages: repairMessages,
        abortSignal,
      });

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
