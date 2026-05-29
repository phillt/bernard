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
import { augmentTools } from '../../tools/augment.js';
import { toolToAISDK } from '../tools/adapter.js';
import { buildToolProfilesPrompt } from '../../tool-profiles.js';
import { getModelProfile } from '../../providers/index.js';
import { isReactEffective } from '../../policy/effective.js';
import { buildSystemPrompt } from '../../agent-prompt.js';
import { SHARE_REASONING_PROMPT, REASONING_FAMILIES } from '../../agent-prompt.js';
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
  /** PlanStore shared with the `plan` tool when `reactMode` is on. */
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
  const profilesBlock = buildToolProfilesPrompt(ctx.stores.toolProfiles);
  if (profilesBlock) {
    systemPrompt += '\n\n' + profilesBlock;
  }
  return systemPrompt;
}

/**
 * Builds the lower-privilege per-turn context message for the main agent.
 * Returns 0 or 1 `CoreMessage`. Used both as the value returned from
 * `mainAgentDefinition.contextMessages` and (for the Agent class's preflight
 * token estimate) so the count reflects the actual wire payload.
 */
export function buildMainContextMessages(
  ctx: AgentContext,
  input: Omit<MainInput, 'systemPrompt'>,
): CoreMessage[] {
  const msg = buildContextMessage({
    memoryStore: ctx.stores.memory,
    ragResults: input.ragResults,
    includeScratch: true,
    mcpServerNames: ctx.mcp.serverNames,
    routineSummaries: input.routineSummaries,
    specialistSummaries: input.specialistSummaries,
    specialistMatches: input.specialistMatches,
    resolvedReferences: input.resolvedReferences,
    alertContext: input.alertContext,
  });
  return msg ? [msg] : [];
}

/**
 * Main agent definition: persistent history (owned by the caller), full tool
 * registry + dispatch tools (`agent`, `task`, `specialist_run`,
 * `tool_wrapper_run`) + `think` + `ask_user` + (`plan` + `evaluate` when
 * `reactMode`), shim routing on low-level tools, error-augmentation,
 * `config.maxSteps`, `buildStrategy` (NormalStrategy or ReActStrategy
 * depending on `config.reactMode`).
 *
 * The definition does NOT own auto-continue, token-overflow recovery, or
 * history-mutation — those stay with the Agent class which provides a
 * `wrapIterate` to {@link runDefinition}.
 */
export const mainAgentDefinition: AgentDefinition<MainInput, string> = {
  id: 'main',
  historyMode: 'persistent',
  repairLabel: 'main',

  systemPrompt(_ctx, input) {
    // The Agent class pre-renders the prompt via `buildMainSystemPrompt` and
    // passes it through `input.systemPrompt` so a single `getModelProfile`
    // call shapes both the preflight estimate and the actual `runAgent` call.
    return input.systemPrompt;
  },

  contextMessages(ctx, input) {
    return buildMainContextMessages(ctx, input);
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
    );
    // Gate plan/evaluate on the SAME effective decision the strategy uses
    // (see strategy(ctx) below). Reading `ctx.config.reactMode` directly
    // would let `tools()` and `strategy()` drift apart the moment a
    // sub-policy emits a `strategyId` that doesn't mirror the global flag.
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
            plan: createPlanTool(input.planStore),
            evaluate: createEvaluateTool(),
          }
        : {}),
    };
    const shimmed = applyShimRouting(tools, ctxToToolWrapperDeps(ctx));
    return augmentTools(shimmed, ctx.stores.toolProfiles);
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
