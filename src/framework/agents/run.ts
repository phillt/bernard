import type { CoreMessage } from 'ai';
import { buildContextMessage, type ContextMessageInputs } from '../../context-message.js';
import { resolveSiteModel } from '../../model-policy.js';
import {
  applyAnthropicPromptCache,
  isAnthropicPromptCacheActive,
} from '../../providers/prompt-cache.js';
import { detectToolError } from '../../tool-profiles.js';
import { makeRepairHook } from '../../tool-call-repair.js';
import { toolBlockBytes } from '../../tool-bytes.js';
import { augmentTools } from '../../tools/augment.js';
import type { AgentContext } from '../context.js';
import { getOutputSink } from '../hooks/output-sink.js';
import {
  tokenStatsHook,
  tokenTotalsHook,
  makeUsageRecorder,
  bucketForTier,
  type HookModelInfo,
} from '../hooks/token-stats.js';
import type { StepFinishPayload } from '../hooks/types.js';
import { runAgent, type AgentResult, type AgentSpec } from '../runner.js';
import type { IterateFn, IterateOpts, StrategyContext } from '../strategies/types.js';
import { resolveToolSurface } from './tool-surface.js';
import type {
  AgentDefinition,
  FormatMeta,
  HistoryMode,
  ModelOverrides,
  ResolvedModel,
} from './types.js';

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
  /**
   * Observer for partial progress so persistent-history callers (the main
   * agent) can preserve completed steps + streamed text when the user aborts
   * mid-turn. Opt-in: cron / sub-agent / task dispatches don't pass it and
   * see zero behavior change.
   *
   * `onIterateStart` fires at the top of every inner iterate call — the reset
   * point. Every LLM re-invocation (wrapIterate overflow retry, auto-continue
   * loop, ReAct enforcement) funnels through the inner iterate, and each of
   * those paths pushes the PRIOR call's messages into persistent history
   * itself, so after a reset the observer accumulates exactly "messages from
   * the current in-flight call not yet in history".
   *
   * `onStepMessages` receives the AI SDK's cumulative `response.messages`
   * snapshot after each completed step. `onTextDelta` receives streamed text
   * of the in-flight step (streaming branch only).
   */
  partialObserver?: {
    onIterateStart?(): void;
    onStepMessages?(cumulativeMessages: CoreMessage[]): void;
    onTextDelta?(delta: string): void;
  };
  /**
   * Per-dispatch telemetry-site override (#299). Wins over `def.telemetrySite`
   * and the resolved site so a single caller can label an otherwise-shared
   * definition — e.g. `tool_wrapper_run` labels each dispatch
   * `tool-wrapper:<specialistId>` and per-server MCP delegation labels its
   * helper `mcp:<server>` — instead of every off-main dispatch folding into
   * the `main` layer in `bernard usage` / the UsageViewer.
   */
  telemetrySite?: string;
}

export interface RunDefinitionResult<TFormatted> {
  result: AgentResult;
  formatted: TFormatted;
  /** Resolved provider/model used for this run (after overrides). */
  resolved: ResolvedModel;
  /**
   * Whether the run ended because it exhausted its step budget while still
   * making tool calls (the final inner iterate ended with
   * `finishReason === 'tool-calls'` at `steps >= maxSteps`), rather than
   * finishing cleanly. Mirrors the value handed to strategies via
   * `strategyCtx.getStepLimitHit`, exposed here so callers can react to an
   * incomplete run — e.g. per-server MCP delegation self-escalates a
   * step-limited single-loop helper to the scoped PAC pipeline (#296 Phase 2E).
   */
  stepLimitHit: boolean;
  /**
   * Wire size of this dispatch's tool block in characters (#323).
   *
   * A lazy accessor, not a value: the measurement converts every schema
   * (O(schema size)) and only one caller — the main agent, budgeting the
   * context it is about to send — ever asks. An eagerly-computed field would
   * charge every dispatch for a number almost none of them read, and an opt-in
   * flag would put the cheap-but-wrong answer in the default position, which is
   * the shape #315/#322 exist to remove. Memoized, so repeated calls are free.
   */
  toolBytes: () => number;
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

  // Central tool-surface resolution (#315, #322). The built-in registry scope
  // (#253) and the MCP bag (#296/#305) are cross-cutting decisions about what
  // a dispatch is entitled to — the same class of concern as the confirm gate
  // installed below, and resolved in the same place for the same reason. Five
  // definitions used to call `mcpToolSurface(ctx)` themselves and four passed
  // `{ surface: 'worker' }` by hand; both defaulted to the expensive option, so
  // a missed call site failed silently and expensively. Deciding here makes the
  // definitions consumers of the answer rather than five copies of the rule.
  const surface = resolveToolSurface(ctx, def);
  const rawTools = await Promise.resolve(def.tools(ctx, input, surface));
  // Tools first, then the prompt that describes them: `task` interpolates
  // `Available tools: …` and used to build its own second registry to do it,
  // which had already drifted from the handed set.
  const system = await Promise.resolve(def.systemPrompt(ctx, input, rawTools));
  // Measured on `rawTools` rather than the augmented set: augmentation wraps
  // `execute` and leaves name/description/parameters — everything that goes on
  // the wire — untouched.
  let measuredToolBytes: number | undefined;
  const toolBytes = (): number => (measuredToolBytes ??= toolBlockBytes(rawTools));
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
    // Profile-persisted grants (#212). Live reader so mid-session grants and
    // profile switches apply immediately. Cron's toolOptions omit it.
    getToolPermissions: ctx.toolOptions.getToolPermissions,
    // Path scoping for writes (#340). Absent for the interactive REPL, which
    // is what leaves a user's own writes unrestricted; supplied by
    // `runHeadless` for every unattended dispatch. Forwarding it here is what
    // makes the gate real — `augmentTools` reads it from ITS options, not from
    // `ctx`, so a scope set on `toolOptions` and not passed on is a scope that
    // silently never applies.
    writeScope: ctx.toolOptions.writeScope,
    // Grants persisted before MCP tools were namespaced (#413) name a bare
    // tool. Built from the whole live MCP surface, never from `rawTools` —
    // see `mcpAliasResolverFor`.
    resolveToolAlias: ctx.mcp.resolveAlias,
    cacheEnabled: config.cacheEnabled,
    // Evidence-pointer registration (#141). Shared by reference into
    // sub-agent / tool-wrapper contexts so a `shell` call inside a wrapper
    // surfaces in the parent's Shift+Tab overlay alongside main-agent calls.
    // Default-closed: cron and other hand-assembled contexts run without a
    // policyDecision, so silently enabling evidence there would populate the
    // shared store with entries the model running that context was never
    // told to cite (cron + sub-agents/wrappers do not inject EVIDENCE_PROMPT).
    provenance: ctx.provenance,
    evidenceEnabled: ctx.policyDecision?.evidence?.requireForVerifiedClaims === true,
    // Rubric wiring (#145). Shared by reference into sub-agent / tool-wrapper
    // contexts so post-write hooks fire and attestation tokens accumulate
    // regardless of which level made the call.
    verificationTracker: ctx.verificationTracker,
    postWriteChecks: ctx.postWriteChecks,
  });
  const partialObserver = opts.partialObserver;
  const hooks = partialObserver?.onStepMessages
    ? [
        ...def.hooks(ctx, input),
        {
          onStepFinish: (payload: StepFinishPayload) => {
            if (payload.response?.messages) {
              partialObserver.onStepMessages!(payload.response.messages as CoreMessage[]);
            }
          },
        },
      ]
    : def.hooks(ctx, input);
  // Per-turn token accounting (#234, #258). Installed here — the one place with
  // the resolved model in scope — so every dispatch's steps are attributed to
  // its tier/site/model in the per-turn ledger. The main agent
  // (`fullTokenAccounting`) gets the full hook (also drives the context gauge +
  // compression headroom); everyone else (sub / task / specialist / tool-wrapper
  // / PAC) gets the totals-only hook so their tokens add to the same odometer +
  // ledger without disturbing the main-only gauge. `ctx.statsTarget` being absent
  // is the cron / headless exemption (the hook is simply not attached).
  const modelInfo: HookModelInfo = {
    bucket: bucketForTier(resolved.tier),
    // Telemetry `site` precedence, most-specific first (#299): a per-dispatch
    // `opts.telemetrySite` override (e.g. `tool-wrapper:<id>`, `mcp:<server>`)
    // wins over a definition's fixed label (PAC phases), then the resolved
    // model site, then `def.site`, then the `main` layer. Without an override an
    // off-main dispatch folds into `main` — the gap #299 closes.
    site: opts.telemetrySite ?? def.telemetrySite ?? resolved.site ?? def.site ?? 'main',
    provider: resolved.provider,
    modelName: resolved.modelName,
  };
  const finalHooks = ctx.statsTarget
    ? [
        ...hooks,
        def.fullTokenAccounting
          ? tokenStatsHook(ctx.statsTarget, modelInfo)
          : tokenTotalsHook(ctx.statsTarget, modelInfo),
      ]
    : hooks;
  const baseMaxSteps = def.stepBudget(config, input);
  const prepareStep = def.prepareStep?.(ctx, input, baseMaxSteps);
  const statsTarget = ctx.statsTarget;
  const repair = def.repairLabel
    ? makeRepairHook({
        config,
        provider: resolved.provider,
        model: resolved.modelName,
        label: def.repairLabel,
        abortSignal: opts.abortSignal,
        // Bring the repair's (full-context) token spend into telemetry, bucketed
        // like the dispatch. It runs inside the dispatch's context, so the trace
        // ids are captured centrally in `telemetryFromUsageRecord` — no stamping.
        tier: resolved.tier,
        onUsage: statsTarget ? makeUsageRecorder(statsTarget) : undefined,
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

  // Phase C (#214) streaming gate. Both conditions must hold: the definition
  // opts in (`main` only today), AND a sink is currently registered (the Ink
  // `<App>` is mounted). The legacy readline REPL never registers a sink, so
  // it always falls through to `generateText` — identical behavior to today.
  const sink = def.streaming ? getOutputSink() : null;
  const useStreaming = sink !== null;
  const onTextDelta = useStreaming
    ? (delta: string) => {
        sink.append({ kind: 'text-delta', text: delta });
        partialObserver?.onTextDelta?.(delta);
      }
    : undefined;
  const onToolCallStart = useStreaming
    ? (ev: { callId: string; toolName: string; args: unknown }) =>
        sink.append({
          kind: 'tool-call',
          callId: ev.callId,
          toolName: ev.toolName,
          args: ev.args,
        })
    : undefined;
  const onToolResult = useStreaming
    ? (ev: { callId: string; toolName: string; result: unknown }) => {
        const errInfo = detectToolError(ev.toolName, ev.result);
        sink.append({
          kind: 'tool-result',
          callId: ev.callId,
          result: ev.result,
          isError: errInfo.isError,
        });
      }
    : undefined;

  // `messages` here is a placeholder — `innerIterate` rebuilds the messages
  // array on every call, so the seed alone is sufficient for the baseSpec.
  const baseSpec: AgentSpec = {
    model: resolved.model,
    providerOptions: resolved.providerOptions,
    params: resolved.params,
    tools,
    maxSteps: baseMaxSteps,
    maxTokens: config.maxTokens,
    system,
    messages: getSeed(),
    abortSignal: opts.abortSignal,
    prepareStep,
    repair,
    hooks: finalHooks,
    useStreaming,
    onTextDelta,
    onToolCallStart,
    onToolResult,
  };

  let stepLimitHit = false;
  const innerIterate: IterateFn = async (iterOpts: IterateOpts) => {
    // Reset the partial-progress recorder for this LLM call. Any prior call's
    // messages have already been (or are about to be) pushed into persistent
    // history by the caller's wrapIterate / strategy extras — see the
    // `partialObserver` doc on RunDefinitionOpts.
    partialObserver?.onIterateStart?.();
    const contextMsgs = await getContextMessages();
    const seedWithContext = insertContextBeforeLastUser(contextMsgs, getSeed());
    const messages = composeMessages(def.historyMode, seedWithContext, iterOpts.extra);
    const sysWithSuffix = iterOpts.systemSuffix ? `${system}\n\n${iterOpts.systemSuffix}` : system;
    const callMaxSteps = iterOpts.maxStepsOverride ?? baseMaxSteps;
    // Anthropic prompt caching (#269): mark the system+tools prefix and the
    // rolling history breakpoint. Scoped to the built-in `anthropic` provider
    // AND to the persistent-history (main) agent — ephemeral one-shot
    // dispatches (sub-agents, specialists, tool-wrappers, PAC, cron) repeat
    // their prefix rarely within the 5-min TTL, so marking them risks paying
    // Anthropic's 1.25x cache-WRITE surcharge for a read that never comes. The
    // main agent re-sends a stable prefix every turn, so it's the only site
    // with a guaranteed payoff. No-op for every other provider/definition.
    const promptCacheActive =
      def.historyMode === 'persistent' &&
      isAnthropicPromptCacheActive(ctx.config, resolved.provider);
    const cached = promptCacheActive
      ? applyAnthropicPromptCache({ system: sysWithSuffix, messages })
      : { system: sysWithSuffix, messages };
    const r = await runAgent({
      ...baseSpec,
      system: cached.system,
      messages: cached.messages,
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
  const formatted = await applyFormat(def, result, input, ctx, {
    stepLimitHit,
    steps: result.steps?.length ?? 0,
  });
  return { result, formatted, resolved, stepLimitHit, toolBytes };
}

function resolveModel<TInput, TFormatted>(
  def: AgentDefinition<TInput, TFormatted>,
  ctx: AgentContext,
  input: TInput,
  overrides: ModelOverrides | undefined,
): ResolvedModel {
  if (def.resolveModel) {
    // Custom resolvers (e.g. per-specialist pins) don't know their site; default
    // it here so ledger attribution (#258) still labels the dispatch. Tier stays
    // whatever the resolver set (typically undefined → bucketed `pinned`).
    const custom = def.resolveModel(ctx, input, overrides);
    return { site: def.site ?? 'main', ...custom };
  }
  const site = resolveSiteModel(ctx.config, def.site ?? 'main', { overrides });
  return {
    model: site.model,
    providerOptions: site.providerOptions,
    params: site.params,
    provider: site.provider,
    modelName: site.modelName,
    tier: site.tier,
    site: def.site ?? 'main',
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

/**
 * The ONLY call site of `def.formatResult`, and therefore the one place the
 * dispatch-level {@link FormatMeta} has to be threaded (#370). `stepLimitHit`
 * is already in lexical scope here — it was computed, returned to
 * the dispatch caller, and then discarded here, which is what forced
 * `tool-wrapper-run` to re-derive it from the formatted payload's own error
 * string. See {@link FormatMeta} for why that inference was unsound.
 */
async function applyFormat<TInput, TFormatted>(
  def: AgentDefinition<TInput, TFormatted>,
  result: AgentResult,
  input: TInput,
  ctx: AgentContext,
  meta: FormatMeta,
): Promise<TFormatted> {
  if (def.formatResult) {
    return Promise.resolve(def.formatResult(result, input, ctx, meta));
  }
  // Default: return result.text (typed as TFormatted by the caller's choice).
  return result.text as unknown as TFormatted;
}
