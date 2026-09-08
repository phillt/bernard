import type { BernardConfig } from '../config.js';
import { MemoryStore } from '../memory.js';
import { RoutineStore } from '../routines.js';
import { SpecialistStore } from '../specialists.js';
import { CandidateStore, type CandidateStoreReader } from '../specialist-candidates.js';
import { CorrectionCandidateStore } from '../correction-candidates.js';
import { ToolProfileStore } from '../tool-profiles.js';
import type { RAGStore } from '../rag.js';
import type { PolicyDecision } from '../policy/types.js';
import type { ToolOptions } from '../tools/types.js';
import { makeUsageRecorder, type TokenStatsTarget } from './hooks/token-stats.js';
import { ProvenanceStore } from '../provenance.js';
import { VerificationStore } from '../agent-status.js';
import { VerificationTracker } from '../verification-tracker.js';
import type { Check } from '../rubric.js';
import type { ToolNameAliasResolver } from '../mcp-names.js';
import type { DispatchProfile } from './agents/dispatch-profile.js';

export interface AgentContextStores {
  memory: MemoryStore;
  routines: RoutineStore;
  specialists: SpecialistStore;
  candidates: CandidateStoreReader;
  correction: CorrectionCandidateStore;
  toolProfiles: ToolProfileStore;
}

export interface AgentContextMCP {
  /**
   * Flat, name-keyed bag of every MCP tool.
   *
   * **Derived from {@link AgentContextMCP.serverTools}, never authored.**
   * `MCPManager.snapshot()` produces it with `flattenServerTools`, so the two
   * share key strings and object identities by construction and cannot
   * disagree about a name (#413).
   */
  tools: Record<string, any>;
  serverNames: string[];
  /**
   * Per-server registry (`{ server: { toolName: tool } }`), populated at
   * bootstrap from `MCPManager.getServerTools()`. Lets per-server delegation
   * (#296) scope a helper sub-agent to one server's tools without reaching for
   * the process-global `getActiveMCPManager()`. `{}` when no MCP servers are
   * connected or in test contexts.
   *
   * Carries the tool OBJECTS, not just names (#413). The name-only shape made
   * every consumer re-look-up each name in `tools`, and that join is what let
   * the two structures disagree — silently, because `dispatchServerDelegate`
   * guarded the lookup with `if (t)` and so degraded to a helper with no tools
   * while still advertising them in its system prompt.
   *
   * Required, not optional: an origin that populates `tools` + `serverNames`
   * but forgets this reduces every `delegate_<server>` to zero tools, which is
   * exactly the bug the cron runner shipped (#305). Build this type via
   * `MCPManager.snapshot()` rather than by hand.
   */
  serverTools: Record<string, Record<string, any>>;
  /**
   * Resolves a tool name persisted before MCP tools were namespaced per server
   * onto the live name it refers to, or `null` when it resolves to nothing or
   * to more than one server's tool (#413).
   *
   * Assembled by `MCPManager.snapshot()` over the WHOLE live surface, which is
   * the point of putting it here rather than letting each consumer build one:
   * inside a `delegate_<server>` helper the dispatch's own registry holds a
   * single server, so a locally-built resolver would find a stored bare
   * `browser_click` unambiguous and honour a grant the user made while a
   * different server owned that name. Building it wrongly is unrepresentable
   * when there is only one assembler.
   *
   * Required, for the same reason as `serverTools`. `assembleContext` defaults
   * it to exact-match-only so a context built without MCP behaves exactly as
   * it did before #413.
   */
  resolveAlias: ToolNameAliasResolver;
}

export interface AgentContext {
  config: BernardConfig;
  stores: AgentContextStores;
  mcp: AgentContextMCP;
  rag?: RAGStore;
  toolOptions: ToolOptions;
  /**
   * Per-turn decision resolved by {@link DefaultPolicyEngine}. Set by the
   * Agent class at the top of `processInput`; read by sub-systems that
   * need to honour policy (today: `mainAgentDefinition.strategy`).
   */
  policyDecision?: PolicyDecision;
  /**
   * Per-turn collection of cite-able sources. Cleared at the start of every
   * `Agent.processInput` turn. Shared by reference with sub-agent /
   * tool-wrapper contexts so retrieval inside a wrapper specialist is
   * visible in the parent's viewer. Issue #173.
   */
  provenance: ProvenanceStore;
  /**
   * Per-turn snapshot of the most recent PAC critic verdict. Cleared at the
   * top of every `Agent.processInput` (and on `Agent.clearHistory`) so a
   * stale verdict never shows up in the Status panel after a new turn or
   * session reset. Written by sub-agent dispatch sites (`tools/subagent.ts`)
   * and read by the Agent Status overlay (issue #140). Shared by reference
   * with sub-agent / tool-wrapper contexts so a nested PAC run still
   * updates the parent's snapshot.
   */
  verification: VerificationStore;
  /**
   * Per-turn tracker that records every tool call (name, args, result preview)
   * and answers `did the agent actually run a verification matching this step's
   * `verification` text?` via token overlap. Cleared at the top of every
   * `Agent.processInput`. Issue #145 check 1.
   */
  verificationTracker: VerificationTracker;
  /**
   * Per-turn sink for post-write schema/state checks produced by
   * `ToolMeta.verifyOutput` hooks. Appended by `augmentTools`; consumed when
   * composing the turn rubric. Cleared at the top of every
   * `Agent.processInput`. Issue #145 check 3.
   */
  postWriteChecks: Check[];
  /**
   * Shared per-turn token-stats accumulator, set by the `Agent` class once it
   * is wired for interactive use (`setSpinnerStats` → `this`, which implements
   * {@link TokenStatsTarget}). Shared by reference into sub-agent / tool-wrapper
   * contexts so `runDefinition` can attach `tokenTotalsHook` to non-main
   * dispatches — making the per-turn ↑/↓ odometer reflect the full turn cost,
   * including offloaded sub-agent work. Absent for cron / headless runs (the
   * totals hook is null-safe and simply not attached). Issue #234.
   */
  statsTarget?: TokenStatsTarget;
}

export interface AssembleContextInput {
  config: BernardConfig;
  toolOptions: ToolOptions;
  mcp?: Partial<AgentContextMCP>;
  rag?: RAGStore;
  stores?: Partial<AgentContextStores>;
  provenance?: ProvenanceStore;
  verification?: VerificationStore;
  verificationTracker?: VerificationTracker;
  postWriteChecks?: Check[];
}

export function assembleContext(input: AssembleContextInput): AgentContext {
  const overrides = input.stores ?? {};
  const stores: AgentContextStores = {
    memory: overrides.memory ?? new MemoryStore(),
    routines: overrides.routines ?? new RoutineStore(),
    specialists: overrides.specialists ?? new SpecialistStore(),
    candidates: overrides.candidates ?? new CandidateStore(),
    correction: overrides.correction ?? new CorrectionCandidateStore(),
    toolProfiles: overrides.toolProfiles ?? new ToolProfileStore(),
  };
  return {
    config: input.config,
    stores,
    mcp: {
      tools: input.mcp?.tools ?? {},
      serverNames: input.mcp?.serverNames ?? [],
      serverTools: input.mcp?.serverTools ?? {},
      // Exact-match-only default: a context built without MCP behaves exactly
      // as it did before #413.
      resolveAlias: input.mcp?.resolveAlias ?? (() => null),
    },
    rag: input.rag,
    toolOptions: input.toolOptions,
    provenance: input.provenance ?? new ProvenanceStore(),
    verification: input.verification ?? new VerificationStore(),
    verificationTracker: input.verificationTracker ?? new VerificationTracker(),
    postWriteChecks: input.postWriteChecks ?? [],
  };
}

/**
 * Narrows a context to the knowledge a dispatch was granted (#511).
 *
 * A scope is a narrowing **view over the live store instance**, derived once in
 * `runDefinition` onto a shadowed `ctx` — which is what makes one change fence
 * both halves. The context block reads `ctx.stores.memory` through
 * `contextInputs`; the `memory` / `scratch` tools read the same field through
 * `def.tools(ctx, …)`. Neither `context-message.ts` nor `createTools` ever
 * learns the word "scope", because the object they are handed is already the
 * fenced one.
 *
 * `pac-critic` is the case that proves the fence is in the right place: it
 * returns `contextInputs: () => null` (no memory block at all) *and* builds
 * `createReadOnlyMemoryTool(ctx.stores.memory)` inside its own `tools()`. A
 * fence in `getContextMessages` would miss it; a fence in `createTools` would
 * miss it too. Only a fence on the store catches both, and the two wrappers
 * compose — one fences actions, the other fences rows.
 *
 * **Returns `ctx` unchanged when nothing is declared**, so the overwhelmingly
 * common path allocates nothing and `main` keeps object identity — which is
 * what keeps its tool block byte-identical for the prompt cache (#269).
 */
export function scopeContext(ctx: AgentContext, profile: DispatchProfile): AgentContext {
  const { memoryScope, knowledgeScope } = profile;
  if (memoryScope === undefined && knowledgeScope === undefined) return ctx;
  // Narrowing is monotone and idempotent in both stores, so re-scoping an
  // already-scoped context can only ever narrow further. That is what lets
  // `tool-wrapper-run.ts` scope early for its pre-assembled child tools and
  // still let `runDefinition` re-derive.
  // **The two axes stay independent**, which is why the memory arm keeps a
  // guard of its own rather than leaning on `scoped(undefined)` returning the
  // receiver: a knowledge-only fence must not reach for the memory store at
  // all. `rag` needs no such guard — it is already reached conditionally.
  return {
    ...ctx,
    stores:
      memoryScope === undefined
        ? ctx.stores
        : { ...ctx.stores, memory: ctx.stores.memory.scoped(memoryScope) },
    rag: ctx.rag?.scoped(knowledgeScope),
  };
}

/**
 * Gives a dispatch's tools a handle for reporting LLM spend they make
 * themselves (#373).
 *
 * `ToolExecOptions` carries no usage handle, so a tool that calls a model has
 * nowhere to report what it cost. This puts one on `ToolOptions` — the bag that
 * already exists for per-dispatch callbacks a tool may reach back through —
 * rather than on `CreateToolsOptions`, which is a decision about which built-in
 * SURFACE a dispatch receives and is guarded by a prompt-cache byte-stability
 * rule that a per-dispatch closure has to argue its way past.
 *
 * Derived here, beside {@link scopeContext}, for the reason that one gives:
 * `runDefinition` is the single place with both a `ctx` and a route to every
 * definition, so no dispatch site has to remember. Returns `ctx` unchanged when
 * there is nothing to record to, or when a caller already supplied one.
 */
export function withUsageRecorder(ctx: AgentContext): AgentContext {
  if (!ctx.statsTarget || ctx.toolOptions.onUsage) return ctx;
  return {
    ...ctx,
    toolOptions: { ...ctx.toolOptions, onUsage: makeUsageRecorder(ctx.statsTarget) },
  };
}
