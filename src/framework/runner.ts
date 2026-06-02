import {
  generateText,
  streamText,
  type CoreMessage,
  type GenerateTextResult,
  type LanguageModel,
  type Tool,
  type ToolCallRepairFunction,
} from 'ai';
import { debugLog } from '../logger.js';
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
  /**
   * Fired the moment the model finishes emitting a complete tool call (i.e.
   * the AI SDK's `tool-call` event in `fullStream`). Lets the caller surface
   * a `⚙ toolName` row in the UI while the tool's `execute` is still running,
   * which would otherwise stay invisible until the entire step finished.
   */
  onToolCallStart?: (event: { callId: string; toolName: string; args: unknown }) => void;
  /**
   * Fired when a tool's `execute` returns. Pairs with `onToolCallStart` by
   * `callId`. Useful for live-updating the result block under the call row.
   */
  onToolResult?: (event: { callId: string; toolName: string; result: unknown }) => void;
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
  const dispatchStartedAt = Date.now();
  const modelId =
    (spec.model as unknown as { modelId?: string }).modelId ?? String(spec.model);
  debugLog('agent:dispatch:start', {
    model: modelId,
    streaming: spec.useStreaming === true,
    systemLen: spec.system?.length ?? 0,
    messagesLen: spec.messages.length,
    toolCount: spec.tools ? Object.keys(spec.tools).length : 0,
    maxSteps: spec.maxSteps,
  });
  try {
    const result = spec.useStreaming
      ? await runStreaming(spec, onStepFinish)
      : await generateText({
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
    debugLog('agent:dispatch:end', {
      model: modelId,
      durationMs: Date.now() - dispatchStartedAt,
      steps: result.steps?.length ?? 0,
      finishReason: result.finishReason,
      promptTokens: result.usage?.promptTokens,
      completionTokens: result.usage?.completionTokens,
    });
    return result;
  } catch (err) {
    debugLog('agent:dispatch:error', {
      model: modelId,
      durationMs: Date.now() - dispatchStartedAt,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
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
  // Defensive: race every await against the parent abort signal. The AI SDK
  // is supposed to settle `textStream` and the result promises when its own
  // `abortSignal` fires, but in practice some providers leave the stream
  // pending after the underlying fetch is cancelled (observed on the OpenAI
  // path mid-reasoning). Without this race the REPL hangs on Esc because the
  // for-await never throws. We pin a single rejecting promise to the signal
  // and race it against each await so an abort always unwinds the runner.
  const abortSignal = spec.abortSignal;
  const abortPromise = abortSignal
    ? new Promise<never>((_, reject) => {
        if (abortSignal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        abortSignal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      })
    : null;
  const raceAbort = async <T>(p: Promise<T>): Promise<T> =>
    abortPromise ? (Promise.race([p, abortPromise]) as Promise<T>) : p;

  // Drain the full stream. `fullStream` (vs `textStream`) emits tool-call /
  // tool-result events as they arrive, so the renderer can show `⚙ toolName`
  // the moment the model finishes the call — without that, MCP tools that
  // sit in `execute` for several seconds look indistinguishable from the
  // model still reasoning. Text deltas remain forwarded via `onTextDelta` so
  // existing callers see no behavior change.
  try {
    const iter = stream.fullStream[Symbol.asyncIterator]();
    while (true) {
      const next = await raceAbort(iter.next());
      if (next.done) break;
      // The AI SDK narrows `tool-call` / `tool-result` parts on the `TOOLS`
      // generic; since we type-erase tools to `Record<string, Tool>` for the
      // shared runner, those branches collapse to `never`. Cast through
      // `unknown` so we can pattern-match on `type` without coupling the
      // runner to a specific tool set.
      const part = next.value as {
        type: string;
        textDelta?: string;
        toolCallId?: string;
        toolName?: string;
        args?: unknown;
        result?: unknown;
        error?: unknown;
      };
      if (part.type === 'text-delta') {
        if (part.textDelta) spec.onTextDelta?.(part.textDelta);
      } else if (part.type === 'tool-call') {
        // Skip malformed events: an empty callId would collide across tool
        // pairings in the sink, and an empty name renders as a blank `⚙ `.
        if (part.toolCallId && part.toolName) {
          spec.onToolCallStart?.({
            callId: part.toolCallId,
            toolName: part.toolName,
            args: part.args,
          });
        }
      } else if (part.type === 'tool-result') {
        if (part.toolCallId && part.toolName) {
          spec.onToolResult?.({
            callId: part.toolCallId,
            toolName: part.toolName,
            result: part.result,
          });
        }
      } else if (part.type === 'error') {
        // Surface stream errors immediately rather than waiting for the
        // settled promises below to re-throw — keeps the original stack.
        // Providers occasionally emit a non-Error value (string, plain
        // object); wrap so downstream `err.message` / `err.name` checks work.
        if (part.error instanceof Error) throw part.error;
        const wrapped = new Error(
          typeof part.error === 'string' ? part.error : JSON.stringify(part.error),
        );
        throw wrapped;
      }
    }
  } catch (err) {
    // Swallow the abort here so the result-promise awaits below can throw the
    // canonical AbortError from the race, keeping the error shape consistent.
    // Gate on `signal.aborted` so a provider-side AbortError (server timeout,
    // internal cancellation) still propagates — otherwise the turn ends with
    // no text and no diagnostic.
    const isUserAbort =
      err instanceof Error && err.name === 'AbortError' && abortSignal?.aborted === true;
    if (!isUserAbort) throw err;
  }
  // Suppress unhandled-rejection noise for the abortPromise once the run is
  // unwinding — every downstream `raceAbort` will surface it as the thrown
  // error from `Promise.all`.
  abortPromise?.catch(() => {});
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
  ] = await raceAbort(
    Promise.all([
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
    ]),
  );
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
