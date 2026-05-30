import type { CoreMessage, Tool } from 'ai';
import { buildStrategy } from '../strategies/index.js';
import { tokenStatsHook, type TokenStatsTarget } from '../hooks/token-stats.js';
import { outputHook } from '../hooks/output.js';
import { createTools } from '../../tools/index.js';
import { createSubAgentTool } from '../../tools/subagent.js';
import { createTaskTool } from '../../tools/task.js';
import { createSpecialistRunTool } from '../../tools/specialist-run.js';
import { createToolWrapperRunTool } from '../../tools/tool-wrapper-run.js';
import { createPlanTool } from '../../tools/plan.js';
import { createThinkTool } from '../../tools/think.js';
import { createAskUserTool } from '../../tools/ask-user.js';
import { createEvaluateTool } from '../../tools/evaluate.js';
import { applyShimRouting } from '../../tools/wrap-with-specialist.js';
import { ctxToToolWrapperDeps } from '../../tools/tool-wrapper-run.js';
import { toolToAISDK } from '../tools/adapter.js';
import { buildToolProfilesPrompt } from '../../tool-profiles.js';
import { getModelProfile } from '../../providers/index.js';
import { isReactEffective } from '../../policy/effective.js';
import { debugLog } from '../../logger.js';
import { buildSystemPrompt } from '../../agent-prompt.js';
import {
  SHARE_REASONING_PROMPT,
  REASONING_FAMILIES,
  CITATIONS_PROMPT,
  CONCISE_PROMPT,
  EVIDENCE_PROMPT,
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
  resolvedReferences?: ResolvedEntry[];
  routineSummaries: RoutineSummary[];
  specialistSummaries: SpecialistSummary[];
  specialistMatches: SpecialistMatch[];
  alertContext?: string;
  /** Mutated in place by `tokenStatsHook`. The Agent class owns this object. */
  statsTarget: TokenStatsTarget;
  /** PlanStore shared with the `plan` tool when coordinator mode is active. */
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
  // Citations policy: append the inline-marker instructions when the
  // policy engine has decided we require citations for factual claims and
  // the active model family does not forbid inline annotations. Issue #173.
  if (
    ctx.policyDecision?.citations?.requireForFactualClaims &&
    !REASONING_FAMILIES.has(profile.family)
  ) {
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
    ragResults: input.ragResults,
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
 * `tool_wrapper_run`) + `think` + `ask_user` + (`plan` + `evaluate` when
 * coordinator mode is active), shim routing on low-level tools,
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

  systemPrompt(_ctx, input) {
    // The Agent class pre-renders the prompt via `buildMainSystemPrompt` and
    // passes it through `input.systemPrompt` so a single `getModelProfile`
    // call shapes both the preflight estimate and the actual `runAgent` call.
    return input.systemPrompt;
  },

  contextInputs(ctx, input) {
    return buildMainContextInputs(ctx, input);
  },

  tools(ctx, input): Record<string, Tool> {
    const baseTools = createTools(
      ctx.toolOptions,
      ctx.stores.memory,
      ctx.mcp.tools,
      ctx.stores.routines,
      ctx.stores.specialists,
      ctx.stores.candidates,
      ctx.config,
      ctx.provenance,
    );
    // Gate plan/evaluate on the SAME effective decision the strategy uses
    // (see strategy(ctx) below). Reading `ctx.config.coordinatorMode`
    // directly would let `tools()` and `strategy()` drift apart the moment a
    // sub-policy (e.g. the Qualifier in 'auto' mode) emits a `strategyId`
    // that doesn't mirror the global flag.
    const reactActive = isReactEffective(ctx.config, ctx.policyDecision);
    const tools: Record<string, Tool> = {
      ...baseTools,
      agent: createSubAgentTool(ctx),
      task: toolToAISDK(createTaskTool(ctx)),
      specialist_run: createSpecialistRunTool(ctx),
      tool_wrapper_run: createToolWrapperRunTool(ctx),
      think: createThinkTool(),
      ask_user: createAskUserTool(ctx.toolOptions.askUser),
      ...(reactActive
        ? {
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
            evaluate: createEvaluateTool(),
          }
        : {}),
    };
    // `augmentTools` (profile-recording + confirmation gate) is applied
    // centrally in `runDefinition`. We only need to return the shimmed tools
    // — main is the only agent that applies the wrap-with-specialist shim.
    return applyShimRouting(tools, ctxToToolWrapperDeps(ctx));
  },

  strategy(ctx) {
    return buildStrategy(ctx.config, { strategyId: ctx.policyDecision?.strategyId });
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

  hooks(_ctx, input) {
    return [tokenStatsHook(input.statsTarget), outputHook()];
  },
};
