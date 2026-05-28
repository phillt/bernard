import type { CoreMessage, LanguageModel, Tool } from 'ai';
import type { BernardConfig } from '../../config.js';
import type { RepairLabel } from '../../tool-call-repair.js';
import type { AgentContext } from '../context.js';
import type { AgentHook } from '../hooks/types.js';
import type { AgentResult } from '../runner.js';
import type { ExecutionStrategy } from '../strategies/types.js';

/**
 * Whether the caller persists conversation history across runs (main agent) or
 * rebuilds the seed messages fresh each call (subagent, specialist, task,
 * tool-wrapper, cron). Correction runs route through `tool_wrapper_run` and
 * therefore use the tool-wrapper definition rather than a dedicated kind.
 */
export type HistoryMode = 'persistent' | 'ephemeral';

/**
 * Per-call provider/model overrides. Dispatch tools may surface these as
 * optional Zod fields (`provider`, `model`) and pass them through to
 * {@link runDefinition}; persistent-history callers may also pass them when
 * `/provider` or `/model` is changed mid-session.
 */
export interface ModelOverrides {
  provider?: string;
  model?: string;
}

/**
 * Resolved model + provider options ready for `runAgent`. Definitions can
 * customise resolution (e.g. honour per-specialist overrides) by implementing
 * {@link AgentDefinition.resolveModel}; otherwise {@link runDefinition} falls
 * back to {@link getModelForConfig} / {@link getProviderOptionsForConfig} with
 * the caller-supplied overrides.
 */
export interface ResolvedModel {
  model: LanguageModel;
  providerOptions?: Parameters<typeof import('ai').generateText>[0]['providerOptions'];
  /** Provider name used (post-override). Available to hooks that need it. */
  provider: string;
  /** Model name used (post-override). */
  modelName: string;
}

/**
 * Declarative description of one agent kind. Each registered kind (main, sub,
 * specialist, task, tool-wrapper, cron) registers exactly one definition; per-
 * instance variation (specialist id, cron job, correction candidate) flows
 * through {@link TInput}, not through more registry entries. Correction is not
 * a registered kind — it runs through `tool_wrapper_run` against the bundled
 * `correction-agent` specialist via the tool-wrapper definition.
 *
 * All methods receive {@link AgentContext} and the per-call {@link TInput} so
 * lookups against stores happen at dispatch time and runtime edits to e.g. a
 * specialist record are picked up transparently.
 */
export interface AgentDefinition<TInput = unknown, TFormatted = unknown> {
  /** Stable kind id used by dispatch + logs. */
  id: string;

  /** Whether the caller persists conversation history (main only) or rebuilds it. */
  historyMode: HistoryMode;

  /** Fully composed system prompt for this run. May be async (memory/RAG reads). */
  systemPrompt(ctx: AgentContext, input: TInput): Promise<string> | string;

  /** Tool subset exposed to the model, as the AI-SDK `Record<name, Tool>` runAgent expects. */
  tools(ctx: AgentContext, input: TInput): Promise<Record<string, Tool>> | Record<string, Tool>;

  /** Strategy selector. Built per-call so e.g. ReAct can be opt-in by definition. */
  strategy(ctx: AgentContext, input: TInput): ExecutionStrategy;

  /** Step budget for the initial iterate call (strategies may scale). */
  stepBudget(config: BernardConfig, input: TInput): number;

  /** Build the seed user message when no explicit `seedMessages` is provided. */
  buildUserMessage(input: TInput): CoreMessage;

  /** Hooks composed onto onStepFinish (output, token-stats, cron-step-recorder, etc.). */
  hooks(ctx: AgentContext, input: TInput): AgentHook[];

  /**
   * Optional model resolution override. Defaults to
   * `{ model: getModelForConfig(config, p, m), providerOptions: ..., provider, modelName }`
   * where `p`/`m` honour {@link ModelOverrides} when supplied.
   */
  resolveModel?(ctx: AgentContext, input: TInput, overrides?: ModelOverrides): ResolvedModel;

  /**
   * Optional AI-SDK `experimental_prepareStep` hook (e.g. force text-only on
   * the final step). Definitions that need it return a single function; the
   * runner installs it on the spec.
   */
  prepareStep?(
    ctx: AgentContext,
    input: TInput,
    maxSteps: number,
  ): Parameters<typeof import('ai').generateText>[0]['experimental_prepareStep'];

  /**
   * Post-processing applied to the final `AgentResult`. Receives the raw result
   * and may return any payload (string, JSON envelope, structured object).
   * Defaults to `result.text` when omitted.
   */
  formatResult?(
    result: AgentResult,
    input: TInput,
    ctx: AgentContext,
  ): TFormatted | Promise<TFormatted>;

  /**
   * Label forwarded to `makeRepairHook` so repair logs are scoped. When
   * omitted, no repair hook is installed for this definition's runs (e.g. the
   * `task` definition historically never had one).
   */
  repairLabel?: RepairLabel;

  /** Optional prefix for log lines emitted from strategies (e.g. `[sub:42]`). */
  prefix?(input: TInput): string | undefined;
}
