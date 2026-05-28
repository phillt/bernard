import type { CoreMessage } from 'ai';
import { defaultProviderErrorMessage, resolveProviderAndModel } from '../../config.js';
import { getModelForConfig, getProviderOptionsForConfig } from '../../providers/index.js';
import { makeRepairHook } from '../../tool-call-repair.js';
import type { AgentContext } from '../context.js';
import { runAgent, type AgentResult, type AgentSpec } from '../runner.js';
import type { IterateFn, IterateOpts, StrategyContext } from '../strategies/types.js';
import type { AgentDefinition, HistoryMode, ModelOverrides, ResolvedModel } from './types.js';

export interface RunDefinitionOpts {
  abortSignal?: AbortSignal;
  /** Per-call provider/model overrides (used when the dispatch tool allows them). */
  overrides?: ModelOverrides;
  /**
   * Explicit seed messages to use instead of `def.buildUserMessage(input)`.
   * The main agent passes its accumulated history through this so persistent
   * history stays owned by the caller. When omitted (ephemeral case), the
   * seed is `[def.buildUserMessage(input)]`.
   *
   * Accepts either an array (captured once) or a function (resolved on every
   * iterate call). The function form is used by the main agent so that
   * persistent-history mutations between iterations (auto-continue partials,
   * emergency-truncate replacement) are picked up by the next call.
   */
  seedMessages?: CoreMessage[] | (() => CoreMessage[]);
  /** Plan store wired into the ReAct strategy enforcement loop. */
  planStore?: StrategyContext['planStore'];
  /**
   * Optional wrapper around the inner per-iteration `IterateFn`. The default
   * `iterate` composes `seedMessages` + `extra` and calls `runAgent`. The main
   * agent wraps it to layer auto-continue, token-overflow recovery, and
   * persistent-history mutation. The wrap receives the inner iterate and may
   * call it multiple times before returning a final {@link AgentResult}.
   */
  wrapIterate?: (inner: IterateFn) => IterateFn;
}

export interface RunDefinitionResult<TFormatted> {
  result: AgentResult;
  formatted: TFormatted;
  /** Resolved provider/model used for this run (after overrides). */
  resolved: ResolvedModel;
}

/**
 * Sole entry point for running an {@link AgentDefinition}. Assembles an
 * {@link AgentSpec} from `def` + `input` + `ctx`, dispatches the definition's
 * strategy with an `iterate` closure that respects `historyMode`, then applies
 * `def.formatResult` to the final result. Individual definitions enforce
 * size caps (e.g. `capSubagentResult`) inline within their `formatResult`.
 *
 * Phase E note: all six registered kinds — main agent, subagent, specialist,
 * task, tool-wrapper, cron — fund this one function (correction reuses the
 * tool-wrapper definition via `tool_wrapper_run`). Cross-cutting
 * changes (model selection, repair-hook wiring, abort handling, hook chain)
 * happen here, not at the call sites.
 */
export async function runDefinition<TInput, TFormatted>(
  ctx: AgentContext,
  def: AgentDefinition<TInput, TFormatted>,
  input: TInput,
  opts: RunDefinitionOpts = {},
): Promise<RunDefinitionResult<TFormatted>> {
  const { config } = ctx;
  const resolved = resolveModel(def, ctx, input, opts.overrides);

  const system = await Promise.resolve(def.systemPrompt(ctx, input));
  const tools = await Promise.resolve(def.tools(ctx, input));
  const hooks = def.hooks(ctx, input);
  const baseMaxSteps = def.stepBudget(config, input);
  const prepareStep = def.prepareStep?.(ctx, input, baseMaxSteps);
  const repair = def.repairLabel
    ? makeRepairHook({
        config,
        provider: resolved.provider,
        model: resolved.modelName,
        label: def.repairLabel,
        abortSignal: opts.abortSignal,
      })
    : undefined;

  const getSeed: () => CoreMessage[] =
    typeof opts.seedMessages === 'function'
      ? opts.seedMessages
      : (() => {
          const arr = opts.seedMessages ?? [def.buildUserMessage(input)];
          return () => arr;
        })();

  const baseSpec: AgentSpec = {
    model: resolved.model,
    providerOptions: resolved.providerOptions,
    tools,
    maxSteps: baseMaxSteps,
    maxTokens: config.maxTokens,
    system,
    messages: getSeed(),
    abortSignal: opts.abortSignal,
    prepareStep,
    repair,
    hooks,
  };

  let stepLimitHit = false;
  const innerIterate: IterateFn = async (iterOpts: IterateOpts) => {
    const messages = composeMessages(def.historyMode, getSeed(), iterOpts.extra);
    const sysWithSuffix = iterOpts.systemSuffix ? `${system}\n\n${iterOpts.systemSuffix}` : system;
    const callMaxSteps = iterOpts.maxStepsOverride ?? baseMaxSteps;
    const r = await runAgent({
      ...baseSpec,
      system: sysWithSuffix,
      messages,
      maxSteps: callMaxSteps,
    });
    stepLimitHit = r.finishReason === 'tool-calls' && (r.steps?.length ?? 0) >= callMaxSteps;
    return r;
  };
  const iterate: IterateFn = opts.wrapIterate ? opts.wrapIterate(innerIterate) : innerIterate;

  const strategy = def.strategy(ctx, input);
  const strategyCtx: StrategyContext = {
    config,
    userInput: extractUserInput(getSeed()),
    abortSignal: opts.abortSignal,
    prefix: def.prefix?.(input),
    planStore: opts.planStore,
    getStepLimitHit: () => stepLimitHit,
    baseMaxSteps,
    iterate,
  };

  const result = await strategy.run(strategyCtx);
  const formatted = await applyFormat(def, result, input, ctx);
  return { result, formatted, resolved };
}

function resolveModel<TInput, TFormatted>(
  def: AgentDefinition<TInput, TFormatted>,
  ctx: AgentContext,
  input: TInput,
  overrides: ModelOverrides | undefined,
): ResolvedModel {
  if (def.resolveModel) {
    return def.resolveModel(ctx, input, overrides);
  }
  const { config } = ctx;
  const resolution = resolveProviderAndModel({
    provider: overrides?.provider,
    model: overrides?.model,
    config,
  });
  if (!resolution.ok) {
    throw new Error(
      defaultProviderErrorMessage(resolution.provider, resolution.envVar, resolution.isCustom),
    );
  }
  return {
    model: getModelForConfig(config, resolution.provider, resolution.model),
    providerOptions: getProviderOptionsForConfig(config, resolution.provider),
    provider: resolution.provider,
    modelName: resolution.model,
  };
}

function composeMessages(
  historyMode: HistoryMode,
  seed: CoreMessage[],
  extra: CoreMessage[],
): CoreMessage[] {
  // Both modes currently behave identically inside runDefinition: the strategy
  // appends `extra` to the seed for this call. Persistent-history callers (the
  // main agent) own their history mutation outside the framework — they pass
  // the up-to-date history in via `seedMessages` on each `runDefinition` call.
  // The `historyMode` field still informs definitions of intent (e.g. enabling
  // assertions in tests) and reserves space for future mode-specific logic.
  void historyMode;
  return extra.length === 0 ? seed : [...seed, ...extra];
}

function extractUserInput(messages: CoreMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        const text = m.content.find((c) => c.type === 'text');
        if (text && 'text' in text) return text.text;
      }
    }
  }
  return '';
}

async function applyFormat<TInput, TFormatted>(
  def: AgentDefinition<TInput, TFormatted>,
  result: AgentResult,
  input: TInput,
  ctx: AgentContext,
): Promise<TFormatted> {
  if (def.formatResult) {
    return Promise.resolve(def.formatResult(result, input, ctx));
  }
  // Default: return result.text (typed as TFormatted by the caller's choice).
  return result.text as unknown as TFormatted;
}
