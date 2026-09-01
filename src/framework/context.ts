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
import type { TokenStatsTarget } from './hooks/token-stats.js';
import { ProvenanceStore } from '../provenance.js';
import { VerificationStore } from '../agent-status.js';
import { VerificationTracker } from '../verification-tracker.js';
import type { Check } from '../rubric.js';

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
    },
    rag: input.rag,
    toolOptions: input.toolOptions,
    provenance: input.provenance ?? new ProvenanceStore(),
    verification: input.verification ?? new VerificationStore(),
    verificationTracker: input.verificationTracker ?? new VerificationTracker(),
    postWriteChecks: input.postWriteChecks ?? [],
  };
}
