import {
  generateText,
  streamText,
  type CoreMessage,
  type GenerateTextResult,
  type LanguageModel,
  type Tool,
  type ToolCallRepairFunction,
} from 'ai';
import type { AgentHook, StepFinishPayload } from './hooks/types.js';

/**
 * Declarative spec for one `generateText` invocation. Callers pre-resolve the
 * model (via `getModelForConfig`) and pass the result here. The runner is
 * intentionally policy-free: retry loops, plan enforcement, critic dispatch,
 * and post-processing all live in the caller.
 */
export interface AgentSpec {
  model: LanguageModel;
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
  tools?: Record<string, Tool>;
  maxSteps?: number;
  maxTokens?: number;
  system?: string;
  messages: CoreMessage[];
  abortSignal?: AbortSignal;
  /** AI SDK accepts at most one — top-level field, not a hook. */
  prepareStep?: Parameters<typeof generateText>[0]['experimental_prepareStep'];
  /** AI SDK accepts at most one — top-level field, not a hook. */
  repair?: ToolCallRepairFunction<any>;
  /** Observer hooks composed in-order on `onStepFinish`. */
  hooks?: AgentHook[];
  /**
   * Phase C (#214): opt-in switch from `generateText` to `streamText` for
   * this run. Only the main-agent dispatch sets this — and only when an
   * output sink is registered, so the deltas have a consumer. Leaving it
   * `false`/undefined keeps every other call site (sub-agents, wrappers,
   * pre-turn LLM passes, context summarization) on the unchanged
   * `generateText` path.
   */
  useStreaming?: boolean;
  /**
   * Called once per text-delta chunk when `useStreaming` is true. The runner
   * still resolves the final {@link AgentResult} after the stream drains, so
   * callers downstream of `runAgent` see the same shape they always did.
   */
  onTextDelta?: (delta: string) => void;
}

/** Result type re-exported so callers needn't depend on `ai` directly. */
export type AgentResult = GenerateTextResult<any, any>;

/**
 * Composes hook `onStepFinish` callbacks into a single AI-SDK callback.
 * Hooks fire in declaration order; an error propagates and aborts the chain.
 */
function composeOnStepFinish(
  hooks: AgentHook[] | undefined,
): ((payload: StepFinishPayload) => Promise<void>) | undefined {
  if (!hooks || hooks.length === 0) return undefined;
  const observers = hooks.filter(
    (h): h is AgentHook & { onStepFinish: NonNullable<AgentHook['onStepFinish']> } =>
      Boolean(h.onStepFinish),
  );
  if (observers.length === 0) return undefined;
  return async (payload: StepFinishPayload) => {
    for (const hook of observers) {
      await hook.onStepFinish(payload);
    }
  };
}

/**
 * Single entry point used by the agent-loop sites that share boilerplate:
 * main agent, subagent, specialist, task, tool-wrapper, cron, critic.
 * Other `generateText` callers (`context.ts`, `prompt-rewriter.ts`,
 * `reference-resolver.ts`, `repl.ts`) are single-shot helpers that do not
 * need the hook chain and stay on the direct AI-SDK call.
 *
 * Cross-cutting behaviors (print-with-prefix, token tracking, structured-log
 * accumulation) are provided by hooks under `src/framework/hooks/`.
 *
 * Phase C goal: zero observable behavior change for the migrated sites. The
 * runner is a thin shim; the only delta vs. inline `generateText` is that
 * `onStepFinish` and `experimental_repairToolCall` are sourced from spec
 * hooks/factories.
 */
export async function runAgent(spec: AgentSpec): Promise<AgentResult> {
  const onStepFinish = composeOnStepFinish(spec.hooks);
  if (spec.useStreaming) {
    return runStreaming(spec, onStepFinish);
  }
  return generateText({
    model: spec.model,
    providerOptions: spec.providerOptions,
    tools: spec.tools,
    maxSteps: spec.maxSteps,
    maxTokens: spec.maxTokens,
    system: spec.system,
    messages: spec.messages,
    abortSignal: spec.abortSignal,
    experimental_prepareStep: spec.prepareStep,
    experimental_repairToolCall: spec.repair,
    onStepFinish,
  });
}

/**
 * `streamText` branch (Phase C, #214). Pushes deltas to `spec.onTextDelta` as
 * they arrive, then assembles a `GenerateTextResult`-shaped object from the
 * `StreamTextResult` promises so callers downstream — strategies, plan
 * enforcement, provenance, format hooks — see no shape difference. The
 * `onStepFinish` hook still fires per step exactly as in the non-streaming
 * path, so tool-call / tool-result events route through `outputHook` to the
 * sink alongside the per-token deltas.
 */
async function runStreaming(
  spec: AgentSpec,
  onStepFinish: ((payload: StepFinishPayload) => Promise<void>) | undefined,
): Promise<AgentResult> {
  // `streamText` accepts a subset of `generateText` settings — no
  // `experimental_prepareStep`. The main agent (the only `streaming: true`
  // definition) doesn't use prepareStep, so this is sound. If a future
  // streaming-capable definition needs prepareStep, the AI SDK has
  // `experimental_continueSteps` for the equivalent steering on this path.
  const stream = streamText({
    model: spec.model,
    providerOptions: spec.providerOptions,
    tools: spec.tools,
    maxSteps: spec.maxSteps,
    maxTokens: spec.maxTokens,
    system: spec.system,
    messages: spec.messages,
    abortSignal: spec.abortSignal,
    experimental_repairToolCall: spec.repair,
    onStepFinish,
  });
  // Drain the text stream so promises resolve. `onTextDelta` lets the caller
  // forward each chunk to the message store; `streamText` continues running
  // even if the consumer is slow because the chunks land on internal queues.
  for await (const delta of stream.textStream) {
    spec.onTextDelta?.(delta);
  }
  // The other promises (toolCalls, toolResults, steps, etc.) are already
  // resolved once textStream completes — awaiting them is cheap.
  const [
    text,
    steps,
    finishReason,
    usage,
    warnings,
    toolCalls,
    toolResults,
    reasoning,
    reasoningDetails,
    providerMetadata,
    request,
    response,
    files,
    sources,
  ] = await Promise.all([
    stream.text,
    stream.steps,
    stream.finishReason,
    stream.usage,
    stream.warnings,
    stream.toolCalls,
    stream.toolResults,
    stream.reasoning,
    stream.reasoningDetails,
    stream.providerMetadata,
    stream.request,
    stream.response,
    stream.files,
    stream.sources,
  ]);
  return {
    text,
    steps,
    finishReason,
    usage,
    warnings,
    toolCalls,
    toolResults,
    reasoning,
    reasoningDetails,
    providerMetadata,
    experimental_providerMetadata: providerMetadata,
    request,
    response,
    files,
    sources,
    experimental_output: undefined as never,
  } as unknown as AgentResult;
}
