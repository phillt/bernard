import type { CoreMessage, LanguageModel, Tool } from 'ai';
import type { BernardConfig } from '../../config.js';
import type { ContextMessageInputs } from '../../context-message.js';
import type { RepairLabel } from '../../tool-call-repair.js';
import type { AgentContext } from '../context.js';
import type { AgentHook } from '../hooks/types.js';
import type { AgentResult } from '../runner.js';
import type { ExecutionStrategy } from '../strategies/types.js';
import type { CreateToolsOptions } from '../../tools/index.js';

/**
 * Dispatch-level facts handed to {@link AgentDefinition.formatResult} (#370).
 *
 * `stepLimitHit` is computed by the runner — it is the one party that knows
 * both the finish reason and the step budget the call was given — and was
 * previously discarded at the format boundary and then *reverse-engineered*
 * downstream by pattern-matching the formatted payload. That inference was
 * wrong in both directions, which is why the fact travels now instead:
 *
 *  - **False positive.** `reclassifyStepLimit` (deleted with this change) read
 *    the `parse_failed` sentinel out of `WrapperResult.error` — a free-form
 *    field `STRUCTURED_OUTPUT_RULES` explicitly tells the model to fill in. A
 *    specialist reporting a *downstream* parse failure as
 *    `{"status":"error","error":"parse_failed"}` was silently relabelled
 *    `step_limit` whenever the run also happened to exhaust its budget.
 *  - **False negative, symmetrically.** It *wrote* `error: 'step_limit'` back
 *    into that same model-written field, and `step_limit` is a real
 *    `ToolErrorType`. A model that writes it produces a taxonomy-valid
 *    classification with no dispatch-level fact behind it at all.
 *
 * `steps` is the number of steps actually completed, so a formatter can say
 * how large the budget it exhausted was rather than just that it ran out.
 */
export interface FormatMeta {
  /** The dispatch ended at its `maxSteps` ceiling while still calling tools. */
  stepLimitHit: boolean;
  /** Steps actually completed by the run. */
  steps: number;
}

/**
 * Whether the caller persists conversation history across runs (main agent) or
 * rebuilds the seed messages fresh each call (subagent, specialist, task,
 * tool-wrapper, cron). Correction runs route through `tool_wrapper_run` and
 * therefore use the tool-wrapper definition rather than a dedicated kind.
 */
export type HistoryMode = 'persistent' | 'ephemeral';

/**
 * The tool surface a dispatch is entitled to, resolved ONCE per dispatch by
 * `runDefinition` and handed to `def.systemPrompt` / `def.tools`.
 *
 * Two cross-cutting facts used to be re-decided by every definition that
 * built a registry (#315, #322):
 *
 *  - `mcpTools` — per-server delegation (#296/#305). Five definitions each
 *    independently remembered to call {@link mcpToolSurface}; a copy that
 *    drifted silently re-introduced the 143-schema prefix the delegation
 *    exists to remove, and `cron` was a sixth that never participated at all
 *    because it took MCP from its own input instead.
 *  - `surface` — the worker tool scoping (#253). `{ surface: 'worker' }` was
 *    hand-passed at four call sites with an expensive default, so forgetting
 *    was silent and cost ~3.7k tokens plus a live routine store on a worker.
 *
 * Resolving both here inverts the failure mode: a definition that ignores the
 * parameter gets the cheap, contained surface rather than the expensive one.
 *
 * Extends {@link CreateToolsOptions} so call sites can pass this object
 * straight through as `createTools`' trailing argument. The `extends` is
 * deliberate: without it the two types were merely structurally compatible by
 * coincidence, and adding a field to `CreateToolsOptions` would have silently
 * changed five call sites with no compiler complaint.
 */
export interface ResolvedToolSurface extends CreateToolsOptions {
  /**
   * Which built-in registry `createTools` should assemble. Required here
   * (optional on {@link CreateToolsOptions}) — a resolved surface always has
   * an answer.
   */
  surface: 'full' | 'worker';
  /**
   * The MCP bag to hand `createTools` — thin `delegate_<server>` tools when
   * delegation is on, the raw schemas otherwise. Mutually exclusive by
   * construction; never merge these with `ctx.mcp.tools`.
   */
  mcpTools: Record<string, Tool>;
}

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
  /**
   * Top-level generation params (issue #286), carried from {@link SiteModel}
   * into the {@link AgentSpec} so the runner spreads them into the call.
   */
  params?: Record<string, unknown>;
  /** Provider name used (post-override). Available to hooks that need it. */
  provider: string;
  /** Model name used (post-override). */
  modelName: string;
  /**
   * Cost tier this dispatch resolved to (#258), carried through from
   * {@link SiteModel} so the token hooks can attribute each step to a tier.
   * `undefined` when the model was pinned by an override/specialist (no tier
   * applies) — the hooks bucket those as `pinned`.
   */
  tier?: import('../../model-policy.js').ModelTier;
  /** Logical site this dispatch belongs to (#258), for ledger attribution. */
  site?: import('../../model-policy.js').ModelSite;
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

  /**
   * Logical site this definition belongs to for the multi-model assignment
   * policy (#170). The default `resolveModel` in {@link runDefinition} passes
   * this to {@link resolveSiteModel}; definitions that supply their own
   * `resolveModel` may ignore it. Defaults to `'main'` when omitted.
   */
  site?: import('../../model-policy.js').ModelSite;

  /**
   * Optional finer-grained label for token-ledger / session-telemetry attribution,
   * decoupled from `site` (which must stay a `ModelSite` for tier resolution).
   * Lets PAC phases attribute as `pac-planner` / `pac-actor` / `pac-critic` while
   * still resolving their model at the `specialist` site. Falls back to `site`.
   */
  telemetrySite?: string;

  /** Whether the caller persists conversation history (main only) or rebuilds it. */
  historyMode: HistoryMode;

  /**
   * Which built-in tool registry this definition is entitled to (#253, #322).
   * Omit it: the default derives from `historyMode` — an ephemeral dispatch
   * gets `'worker'` (the groups declaring `audience: 'main'` in `createTools`
   * are dropped), a persistent one gets `'full'`.
   *
   * Declare it only to opt OUT of that derivation, and say why. `tool-wrapper`
   * is the sole definition that does: its `childTools` are scoped by
   * `specialist.targetTools`, and three bundled wrappers target tools the
   * worker surface removes (`mcp-manager` → `mcp_config` / `mcp_add_url` /
   * `mcp_verify`; `correction-agent` and `specialist-creator` → `specialist`).
   * `dispatchToolWrapper` reads this field when assembling that registry, so
   * the declaration drives the behavior rather than only documenting it.
   *
   * Resolved once per dispatch by `runDefinition` via `resolveToolSurface` and
   * handed to `systemPrompt` / `tools` — definitions never re-derive it.
   */
  toolSurface?: 'full' | 'worker';

  /**
   * Tool subset exposed to the model, as the AI-SDK `Record<name, Tool>`
   * runAgent expects. `surface` carries the two cross-cutting decisions
   * `runDefinition` owns — the built-in registry scope and the MCP bag — so
   * pass it straight through to `createTools` rather than re-deciding either.
   *
   * Resolved BEFORE `systemPrompt`, which receives the result.
   */
  tools(
    ctx: AgentContext,
    input: TInput,
    surface: ResolvedToolSurface,
  ): Promise<Record<string, Tool>> | Record<string, Tool>;

  /**
   * Fully composed system prompt for this run. May be async (memory/RAG reads).
   *
   * Receives the registry `tools` just returned, so a definition that
   * advertises its tool list in prose (`task`) names the exact set it was
   * handed. It previously assembled a SECOND registry for that — which had
   * already drifted once (the prompt path passed no provenance, so `cite` was
   * handed but never advertised). Passing the built set closes the drift by
   * construction and drops the duplicate build.
   */
  systemPrompt(
    ctx: AgentContext,
    input: TInput,
    tools: Record<string, Tool>,
  ): Promise<string> | string;

  /** Strategy selector. Built per-call so e.g. ReAct can be opt-in by definition. */
  strategy(ctx: AgentContext, input: TInput): ExecutionStrategy;

  /** Step budget for the initial iterate call (strategies may scale). */
  stepBudget(config: BernardConfig, input: TInput): number;

  /** Build the seed user message when no explicit `seedMessages` is provided. */
  buildUserMessage(input: TInput): CoreMessage;

  /**
   * Per-turn extras merged into the framework-managed
   * `<system_provided_context>` block. The framework always wraps
   * `memoryStore` + `includeScratch: true` by default — definitions only
   * declare what they add on top (RAG hits, MCP server names, routine /
   * specialist listings, resolved references, alert context, provenance).
   * Issue #143.
   *
   * Returning `null` is an explicit opt-out (no context message is injected
   * at all). This is the contract used by `pac-critic`, which exposes
   * `memory.read` / `scratch.read` as tools instead of injecting memory
   * up-front.
   *
   * Omitting this method entirely gets the safe default: a context message
   * with `<persistent_memory>` + `<scratch_notes>` populated from
   * `ctx.stores.memory`. Adding a brand-new `AgentDefinition` therefore
   * inherits OWASP LLM01 channel separation without any per-definition
   * wiring (issue #172 + #143).
   *
   * Rebuilt on every iterate call — NOT persisted into the caller's history.
   *
   * `memoryStore` is intentionally omitted from the return type: definitions
   * MUST NOT shadow the framework-injected store, because doing so would
   * silently drop `<persistent_memory>` + `<scratch_notes>` and re-introduce
   * the LLM01 vector this contract exists to prevent. To opt out entirely,
   * return `null`.
   */
  contextInputs?(
    ctx: AgentContext,
    input: TInput,
  ):
    | Partial<Omit<ContextMessageInputs, 'memoryStore'>>
    | null
    | Promise<Partial<Omit<ContextMessageInputs, 'memoryStore'>> | null>;

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
   *
   * `meta` carries the dispatch-level facts a formatter cannot recover from
   * `AgentResult` alone — see {@link FormatMeta}. Adding it required no edits to
   * the nine existing implementations, because a function of fewer parameters is
   * assignable to a signature of more — plain arity assignability, nothing to do
   * with bivariance (an earlier version of this comment said otherwise).
   *
   * It is marked optional only for callers outside `applyFormat`: the tests that
   * invoke a definition's `formatResult` directly. `applyFormat` types it as
   * required and always passes it, so no production path reaches the `undefined`
   * branch. Callers that destructure it should read `meta?.stepLimitHit` and
   * treat absence as "unknown", never as "the run finished".
   *
   * **Where the verdict lands is deliberately not uniform, and #351 should know
   * it.** `task` and `tool-wrapper` mint `status: 'error'` envelopes, which
   * `detectResultFailure` reads as failures; `sub`, `specialist`, `pac-actor`
   * and `mcp-delegate` return prose with a preamble, which it reads as SUCCESS.
   * So a step-limited run is a failure at two of six formatters and a success at
   * four. `RunDefinitionResult.stepLimitHit` is still returned to all five
   * dispatch tools, so a pass centralizing the error path there will find this
   * fact already folded into the payload one layer below and must either
   * special-case it or re-derive it.
   */
  formatResult?(
    result: AgentResult,
    input: TInput,
    ctx: AgentContext,
    meta?: FormatMeta,
  ): TFormatted | Promise<TFormatted>;

  /**
   * Label forwarded to `makeRepairHook` so repair logs are scoped. When
   * omitted, no repair hook is installed for this definition's runs (e.g. the
   * `task` definition historically never had one).
   */
  repairLabel?: RepairLabel;

  /** Optional prefix for log lines emitted from strategies (e.g. `[sub:42]`). */
  prefix?(input: TInput): string | undefined;

  /**
   * Phase C (#214): when `true` AND an output sink is registered via
   * `setOutputSink`, the runner uses `streamText` instead of `generateText`
   * and pushes per-token deltas into the sink for this definition's runs.
   * When false / omitted, the run stays on `generateText` regardless of
   * whether a sink is active. Only the main-agent definition sets this so
   * sub-agent / specialist / tool-wrapper dispatches don't interleave
   * concurrent token streams in the terminal.
   */
  streaming?: boolean;

  /**
   * Selects which token-accounting hook `runDefinition` installs centrally
   * (#258): `true` → `tokenStatsHook` (full per-turn odometer + context gauge +
   * compression headroom); `false`/unset → the totals-only `tokenTotalsHook`
   * (adds tokens to the per-turn ↑/↓ ledger without touching the gauge/headroom).
   * Only the main-agent definition sets `true`. The definitions' own `hooks()` no
   * longer install either hook — `runDefinition` owns it from the one place that
   * has the resolved model identity in scope, so exactly one hook is wired per
   * dispatch (no double-count). Keeping this a flag (rather than a hardcoded id
   * check) keeps the accounting contract co-located with what it describes. #234.
   */
  fullTokenAccounting?: boolean;
}
