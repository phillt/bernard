import type { CoreMessage } from 'ai';
import { buildContextMessage, type ContextMessageInputs } from '../../context-message.js';
import { resolveSiteModel } from '../../model-policy.js';
import { makeRepairHook } from '../../tool-call-repair.js';
import { augmentTools } from '../../tools/augment.js';
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
  const rawTools = await Promise.resolve(def.tools(ctx, input));
  // Central confirmation-gate install (#144). Every agent runs through this
  // path, so applying the gate here (instead of inside each definition's
  // `tools()`) means sub-agent / PAC / specialist / cron tool calls all
  // respect `confirmThreshold` + `confirmAction`. The main agent's
  // shim-routing happens upstream in `def.tools(ctx, input)` so `augmentTools`
  // sees the shimmed tools and wraps them once.
  const tools = augmentTools(rawTools, {
    profileStore: ctx.stores.toolProfiles,
    confirmThreshold: ctx.policyDecision?.toolMode?.confirmThreshold,
    confirmAction: ctx.toolOptions.confirmAction,
    toolMode: ctx.policyDecision?.toolMode?.mode,
    blockAction: ctx.toolOptions.blockAction,
    sessionToolAllowlist: ctx.toolOptions.sessionToolAllowlist,
    cacheEnabled: config.cacheEnabled,
  });
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

  // Per-turn lower-privilege context (issue #172 + #143). The framework
  // ALWAYS wraps `memoryStore` + `includeScratch: true` by default so a new
  // AgentDefinition inherits OWASP LLM01 channel separation without
  // remembering to wire it up. Definitions only declare extras (RAG hits,
  // MCP names, routine listings, etc.) via `contextInputs`. Returning `null`
  // opts the definition out entirely (used by pac-critic, which exposes
  // `memory.read` / `scratch.read` as tools instead).
  //
  // Resolved fresh on every iterate so memory updates / new RAG hits are
  // reflected, and NOT persisted into the caller's history.
  const getContextMessages = async (): Promise<CoreMessage[]> => {
    let extras: Partial<Omit<ContextMessageInputs, 'memoryStore'>> | null = {};
    if (def.contextInputs) {
      try {
        extras = await Promise.resolve(def.contextInputs(ctx, input));
      } catch {
        // Fail-soft: a thrown contextInputs (e.g. RAG search error) must not
        // abort the turn. Drop the extras and fall back to the framework
        // default memory + scratch contract.
        extras = {};
      }
    }
    if (extras === null) return [];
    const msg = buildContextMessage({
      ...extras,
      memoryStore: ctx.stores.memory,
      includeScratch: extras.includeScratch ?? true,
    });
    return msg ? [msg] : [];
  };

  // `messages` here is a placeholder — `innerIterate` rebuilds the messages
  // array on every call, so the seed alone is sufficient for the baseSpec.
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
    const contextMsgs = await getContextMessages();
    const seedWithContext = insertContextBeforeLastUser(contextMsgs, getSeed());
    const messages = composeMessages(def.historyMode, seedWithContext, iterOpts.extra);
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
  const site = resolveSiteModel(ctx.config, def.site ?? 'main', { overrides });
  return {
    model: site.model,
    providerOptions: site.providerOptions,
    provider: site.provider,
    modelName: site.modelName,
  };
}

/**
 * Inserts the per-turn `<system_provided_context>` message(s) immediately
 * BEFORE the current (last) user message in the seed, rather than at index 0.
 *
 * For multi-turn persistent histories this matters: prepending at index 0
 * would place metadata for the CURRENT turn (resolved references for the
 * current question, fresh RAG hits, the latest alert context) ahead of every
 * historical turn — temporally disconnected from the question it annotates.
 * Inserting next to the current user message keeps the metadata adjacent to
 * the turn it describes.
 *
 * If the seed contains no user message (unusual), falls back to prepending.
 */
function insertContextBeforeLastUser(
  contextMsgs: CoreMessage[],
  seed: CoreMessage[],
): CoreMessage[] {
  if (contextMsgs.length === 0) return seed;
  for (let i = seed.length - 1; i >= 0; i--) {
    if (seed[i].role === 'user') {
      return [...seed.slice(0, i), ...contextMsgs, ...seed.slice(i)];
    }
  }
  return [...contextMsgs, ...seed];
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
