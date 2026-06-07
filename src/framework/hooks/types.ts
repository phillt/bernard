import type { CoreMessage } from 'ai';

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
