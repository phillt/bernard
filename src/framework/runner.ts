import {
  generateText,
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
 * Single entry point that replaces every direct `generateText({ ... })` call
 * across the codebase. Cross-cutting behaviors (print-with-prefix, token
 * tracking, structured-log accumulation) are provided by hooks under
 * `src/framework/hooks/`.
 *
 * Phase C goal: zero observable behavior change. The runner is a thin shim;
 * the only delta vs. inline `generateText` is that `onStepFinish` and
 * `experimental_repairToolCall` are sourced from spec hooks/factories.
 */
export async function runAgent(spec: AgentSpec): Promise<AgentResult> {
  const onStepFinish = composeOnStepFinish(spec.hooks);
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
