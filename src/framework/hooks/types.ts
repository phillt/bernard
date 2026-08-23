import type { CoreMessage } from 'ai';

/**
 * Per-step provider metadata carrying prompt-cache token counts (#269), keyed by
 * the AI SDK's provider namespace — `anthropic`, `openai`, `xai`, or a custom
 * provider's own name, since each SDK writes under its own key. Values are
 * `number | null`; `null` means "cache miss", not "unknown".
 *
 * The two shapes below are NOT interchangeable — they disagree about whether
 * cached tokens are already counted in `usage.promptTokens`. Normalize with
 * `normalizeUsage` (`./token-stats.js`) rather than reading these directly.
 */
export interface CacheMetadata {
  [namespace: string]:
    | {
        /** Anthropic: cache-write tokens, DISJOINT from `usage.promptTokens`. */
        cacheCreationInputTokens?: number | null;
        /** Anthropic: cache-read tokens, DISJOINT from `usage.promptTokens`. */
        cacheReadInputTokens?: number | null;
        /** OpenAI-compatible: cache-read tokens, a SUBSET of `usage.promptTokens`. */
        cachedPromptTokens?: number | null;
      }
    | undefined;
}

/**
 * Payload passed to `onStepFinish` by the AI SDK after each generation step.
 *
 * This is the structural subset our hooks use; the underlying AI-SDK type
 * carries additional fields we don't depend on.
 */
export interface StepFinishPayload {
  text: string;
  toolCalls: { toolName: string; toolCallId: string; args: unknown }[];
  toolResults: { toolName: string; toolCallId: string; result: unknown }[];
  usage?: { promptTokens: number; completionTokens: number };
  finishReason?: string;
  /**
   * Per-step provider metadata, keyed by the AI SDK's provider namespace.
   * Optional because hooks are also exercised with hand-built payloads in tests.
   * See {@link CacheMetadata} for the per-provider cache-token shapes.
   */
  providerMetadata?: CacheMetadata;
  /**
   * The AI SDK's `StepResult.response` — `messages` is a CUMULATIVE snapshot
   * of every response message generated so far in this call (verified for
   * both `generateText` and `streamText` in ai@4.1). Optional because hooks
   * are also exercised with hand-built payloads in tests.
   */
  response?: { messages?: CoreMessage[] };
}

/**
 * Composable observer hook for a {@link runAgent} run. Each hook may inspect a
 * completed step and trigger side effects (printing, token tracking, log
 * accumulation). Hooks are invoked in declaration order; an error from one
 * hook propagates and aborts later hooks for that step.
 *
 * Hooks are deliberately observe-only — they cannot rewrite tool calls or
 * abort the run. Behavior-replacing slots like `experimental_repairToolCall`
 * and `experimental_prepareStep` are top-level `AgentSpec` fields, since the
 * AI SDK only accepts one value for each.
 */
export interface AgentHook {
  onStepFinish?(step: StepFinishPayload): void | Promise<void>;
}
