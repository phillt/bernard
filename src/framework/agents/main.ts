import type { CoreMessage, Tool } from 'ai';
import { buildStrategy } from '../strategies/index.js';
import type { TokenStatsTarget } from '../hooks/token-stats.js';
import { outputHook } from '../hooks/output.js';
import { createTools } from '../../tools/index.js';
import { formatCurrentDateTime } from '../../tools/datetime.js';
import { createSubAgentTool } from '../../tools/subagent.js';
import { createTaskTool } from '../../tools/task.js';
import { createSpecialistRunTool } from '../../tools/specialist-run.js';
import { createToolWrapperRunTool } from '../../tools/tool-wrapper-run.js';
import { createPlanTool } from '../../tools/plan.js';
import { createThinkTool } from '../../tools/think.js';
import { createAskUserTool } from '../../tools/ask-user.js';
import { createEvaluateTool } from '../../tools/evaluate.js';
import { applyShimRouting } from '../../tools/wrap-with-specialist.js';
import { toolToAISDK } from '../tools/adapter.js';
import { buildToolProfilesPrompt } from '../../tool-profiles.js';
import { getModelProfile } from '../../providers/index.js';
import { isReactPossible } from '../../policy/effective.js';
import { debugLog } from '../../logger.js';
import { buildSystemPrompt } from '../../agent-prompt.js';
import {
  SHARE_REASONING_PROMPT,
  REASONING_FAMILIES,
  CITATIONS_PROMPT,
  CONCISE_PROMPT,
  EVIDENCE_PROMPT,
  RESPONSE_STYLE_PROMPTS,
} from '../../agent-prompt.js';
import { buildContextMessage } from '../../context-message.js';
import type { RAGSearchResult } from '../../rag.js';
import type { RoutineSummary } from '../../routines.js';
import type { SpecialistSummary } from '../../specialists.js';
import type { SpecialistMatch } from '../../specialist-matcher.js';
import type { ResolvedEntry } from '../../reference-resolver.js';
import type { AgentContext } from '../context.js';
import type { AgentDefinition } from './types.js';

/**
 * Per-call payload for the main agent. The Agent class at `src/agent.ts`
 * assembles this each turn and passes it through {@link runDefinition} along
 * with `seedMessages: () => this.history` and a `wrapIterate` that handles
 * auto-continue, token-overflow recovery, and persistent-history mutation.
 *
 * Pre-computed fields (RAG, routines, specialists, matches, resolvedReferences)
 * are passed in rather than recomputed in the definition because they depend
 * on the just-pushed user message and are also used by callers (e.g. spinner
 * stats, RAG stickiness tracking).
 */
export interface MainInput {
  userInput: string;
  ragResults?: RAGSearchResult[];
  /** Curator outputs; see `recall-filter.ts` and `orderForPacking` (#371). */
  recallReconciliation?: string;
  memoryPriority?: string[];
  resolvedReferences?: ResolvedEntry[];
  routineSummaries: RoutineSummary[];
  specialistSummaries: SpecialistSummary[];
  specialistMatches: SpecialistMatch[];
  alertContext?: string;
  /** Mutated in place by `tokenStatsHook`. The Agent class owns this object. */
  statsTarget: TokenStatsTarget;
  /** PlanStore shared with the `plan` tool (exposed in every mode). */
  planStore: import('../../plan-store.js').PlanStore;
  /**
   * Pre-rendered system prompt. The Agent class builds it once via
   * {@link buildMainSystemPrompt} so the preflight token estimate and the
   * `runDefinition` call see the exact same string (some `getModelProfile`
   * stubs in tests use `mockReturnValueOnce`).
   */
  systemPrompt: string;
}

/**
 * Builds the system prompt for the main agent: `buildSystemPrompt` (static
 * base, MCP/routine/specialist guidance, date/time/provider) plus
 * model-profile systemSuffix, share-reasoning block, and tool-profile usage
 * block. All operator-controlled — no memory, RAG, scratch, MCP names,
 * routine/specialist lists, resolved references, or alert context. Those
 * are emitted via {@link buildMainContextMessages} as a separate user-role
 * `<system_provided_context>` message (issue #172).
 *
 * Pure function — call once per turn. `profile` is passed in (rather than
 * looked up here) so that the Agent class can share a single
 * `getModelProfile(...)` call between `profile.wrapUserMessage(...)` and
 * this builder.
 */
export function buildMainSystemPrompt(
  ctx: AgentContext,
  _input: Omit<MainInput, 'systemPrompt'>,
  profile: ReturnType<typeof getModelProfile>,
): string {
  let systemPrompt = buildSystemPrompt(ctx.config);
  if (profile.systemSuffix) {
    systemPrompt += '\n\n' + profile.systemSuffix;
  }
  if (!REASONING_FAMILIES.has(profile.family)) {
    systemPrompt += '\n\n' + SHARE_REASONING_PROMPT;
  }
  // Citations are ALWAYS on for the main agent — grounding factual claims in
  // checked sources (rather than guessing) is a core requirement, not a
  // policy-tunable one, so this deliberately does NOT consult
  // `policyDecision.citations`. The only carve-out is `REASONING_FAMILIES`
  // (OpenAI/xAI reasoning models), whose systemSuffix already forbids narrating
  // inline markers — forcing `[^Sn]` there would conflict with that guidance.
  if (!REASONING_FAMILIES.has(profile.family)) {
    systemPrompt += '\n\n' + CITATIONS_PROMPT;
  }
  // Evidence-pointer policy: append the `## Evidence Pointers` block when the
  // policy engine has decided we require markers for verified claims and the
  // active model family does not forbid inline annotations. Issue #141.
  if (
    ctx.policyDecision?.evidence?.requireForVerifiedClaims &&
    !REASONING_FAMILIES.has(profile.family)
  ) {
    systemPrompt += '\n\n' + EVIDENCE_PROMPT;
  }
  // Concise-mode shaping: append the concise block when the policy enables it.
  // Issue #175. No model-family gate — concision is universal.
  if (ctx.policyDecision?.concise?.enabled) {
    systemPrompt += '\n\n' + CONCISE_PROMPT;
  }
  // Response-style shaping (#133): orthogonal to concise. The block describes
  // the form/perspective the user wants; concise still governs length budget.
  const stylePrompt = RESPONSE_STYLE_PROMPTS[ctx.config.responseStyle];
  if (stylePrompt) {
    systemPrompt += '\n\n' + stylePrompt;
  }
  const profilesBlock = buildToolProfilesPrompt(ctx.stores.toolProfiles);
  if (profilesBlock) {
    systemPrompt += '\n\n' + profilesBlock;
  }
  return systemPrompt;
}

/**
 * Builds the lower-privilege per-turn context-message extras for the main
 * agent. Used both by the Agent class's preflight token estimate (via
 * {@link buildMainContextMessages}) and by `mainAgentDefinition.contextInputs`
 * — the framework merges these into a `buildContextMessage` call that also
 * supplies the default `memoryStore` + `includeScratch: true` (issue #143).
 */
function buildMainContextInputs(ctx: AgentContext, input: Omit<MainInput, 'systemPrompt'>) {
  return {
    // Rendered in the volatile per-turn block (not the system prompt) so the
    // main agent's cacheable system prefix stays byte-stable for prompt
    // caching (#269). Scoped to the main agent — ephemeral sub-agents keep
    // their prior (often context-less) message shape.
    currentDateTime: formatCurrentDateTime(),
    ragResults: input.ragResults,
    recallReconciliation: input.recallReconciliation,
    memoryPriority: input.memoryPriority,
    mcpServerNames: ctx.mcp.serverNames,
    routineSummaries: input.routineSummaries,
    specialistSummaries: input.specialistSummaries,
    specialistMatches: input.specialistMatches,
    resolvedReferences: input.resolvedReferences,
    alertContext: input.alertContext,
    provenance: ctx.provenance,
  };
}

/**
 * Preflight-estimate helper: returns the 0-or-1 `CoreMessage` array that the
 * framework will inject for the main agent. The Agent class (`src/agent.ts`)
 * calls this to size its token budget so the count reflects the actual wire
 * payload that `runDefinition` will produce.
 */
export function buildMainContextMessages(
  ctx: AgentContext,
  input: Omit<MainInput, 'systemPrompt'>,
): CoreMessage[] {
  const msg = buildContextMessage({
    memoryStore: ctx.stores.memory,
    includeScratch: true,
    ...buildMainContextInputs(ctx, input),
  });
  return msg ? [msg] : [];
}

/**
 * Main agent definition: persistent history (owned by the caller), full tool
 * registry + dispatch tools (`agent`, `task`, `specialist_run`,
 * `tool_wrapper_run`) + `think` + `ask_user` + `plan` (every mode) + `evaluate`
 * (coordinator mode only), shim routing on low-level tools,
 * error-augmentation, `config.maxSteps`, `buildStrategy` (NormalStrategy or
 * ReActStrategy depending on the per-turn policy decision /
 * `config.coordinatorMode`).
 *
 * The definition does NOT own auto-continue, token-overflow recovery, or
 * history-mutation — those stay with the Agent class which provides a
 * `wrapIterate` to {@link runDefinition}.
 */
export const mainAgentDefinition: AgentDefinition<MainInput, string> = {
  id: 'main',
  site: 'main',
  historyMode: 'persistent',
  repairLabel: 'main',
  // Phase C (#214): main-only token streaming. Sub-agents / specialists /
  // tool-wrappers stay on `generateText` so concurrent dispatches don't
  // interleave token streams in the terminal. The streaming branch only
  // activates when `setOutputSink` has registered a consumer.
  streaming: true,

  // #234/#258: `runDefinition` installs the *full* `tokenStatsHook` for this
  // definition (instead of the totals-only `tokenTotalsHook`) because it does
  // full per-turn accounting — driving the context gauge + compression headroom,
  // not just the ↑/↓ odometer. The flag picks which hook variant is appended.
  fullTokenAccounting: true,

  systemPrompt(_ctx, input) {
    // The Agent class pre-renders the prompt via `buildMainSystemPrompt` and
    // passes it through `input.systemPrompt` so a single `getModelProfile`
    // call shapes both the preflight estimate and the actual `runAgent` call.
    return input.systemPrompt;
  },

  contextInputs(ctx, input) {
    return buildMainContextInputs(ctx, input);
  },

  tools(ctx, input, surface): Record<string, Tool> {
    // `surface.mcpTools` is per-server MCP delegation (#296): when on, the main
    // agent carries ONE thin `delegate_<server>` tool per connected server
    // instead of every MCP tool's schema. The real schemas live only inside
    // each helper sub-agent's scoped registry (assembled in
    // `src/tools/delegate.ts`), so they never re-bill in the main prefix every
    // step. When off, MCP tools are exposed directly as before. Either way the
    // set is session-stable (servers fix at startup), preserving the
    // byte-stable tool block the prompt cache needs.
    //
    // `surface.surface` is `'full'` here by derivation — main is the only
    // `historyMode: 'persistent'` definition — so the config/scheduling tools
    // the worker surface drops (#253) stay present.
    const baseTools = createTools(
      ctx.toolOptions,
      ctx.stores.memory,
      surface.mcpTools,
      ctx.stores.routines,
      ctx.stores.specialists,
      ctx.stores.candidates,
      ctx.config,
      ctx.provenance,
      surface,
    );
    // `evaluate` is the verification half of the ReAct think→act→evaluate loop.
    // It is gated on whether ReAct is POSSIBLE this SESSION (`isReactPossible`,
    // config-only) rather than the per-turn decision (#269). Gating it per turn
    // (`isReactEffective`) made the tool block flip between Normal and ReAct
    // turns in 'auto' mode, which invalidates the Anthropic prompt cache every
    // time the strategy changes — tools are the first/largest cached block and
    // can't carry a mid-array breakpoint, so the whole block must stay
    // byte-identical across turns for the cache to hit.
    //
    // Keeping `evaluate` present for the whole session (when mode != 'off') is
    // harmless on Normal turns because it is an inert reflection tool. The
    // always-on `plan` tool is NOT in that category — it mutates user-visible
    // state — which is why #303 split enforcement so a Normal turn still has to
    // reconcile a plan it chose to make. Enforcement lives in the strategy
    // layer either way, so an exposed `evaluate` on a single-shot turn just
    // gives the model a place to record a verification.
    const reactToolsAvailable = isReactPossible(ctx.config);
    const tools: Record<string, Tool> = {
      ...baseTools,
      agent: createSubAgentTool(ctx),
      task: toolToAISDK(createTaskTool(ctx)),
      specialist_run: createSpecialistRunTool(ctx),
      tool_wrapper_run: createToolWrapperRunTool(ctx),
      think: createThinkTool(),
      ask_user: createAskUserTool(ctx.toolOptions.askUser),
      plan: createPlanTool(input.planStore, () => {
        ctx.stores.memory.clearScratch();
        // Match the payload shape used by `scratchPolicy` so log
        // consumers can grep `scratch:reset` uniformly.
        debugLog('scratch:reset', {
          resetAll: true,
          deletePlanKey: true,
          reason: 'plan-replaced',
        });
      }),
      ...(reactToolsAvailable ? { evaluate: createEvaluateTool(ctx.verification) } : {}),
    };
    // `augmentTools` (profile-recording + confirmation gate) is applied
    // centrally in `runDefinition`. We only need to return the shimmed tools
    // — main is the only agent that applies the wrap-with-specialist shim.
    return applyShimRouting(tools, ctx);
  },

  strategy(ctx) {
    return buildStrategy(ctx.config, {
      strategyId: ctx.policyDecision?.strategyId,
      // Main is the only site that opts in: its plans are the ones rendered in
      // the plan panel, so an abandoned one is a visible broken promise (#303).
      enforcePlanReconcile: true,
    });
  },

  stepBudget(config) {
    return config.maxSteps;
  },

  buildUserMessage(): CoreMessage {
    // Main agent always supplies its own `seedMessages` (the persistent
    // history). This is never used at runtime — but the field is required by
    // the type.
    return { role: 'user', content: '' };
  },

  hooks(_ctx, _input) {
    // The token-accounting hook (`tokenStatsHook`) is installed centrally in
    // `runDefinition` (#258) where the resolved tier/site is in scope, so it can
    // attribute the main agent's steps to the per-turn ledger. We only add the
    // output sink here.
    return [outputHook()];
  },
};
