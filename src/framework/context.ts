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
import { ProvenanceStore } from '../provenance.js';
import { VerificationStore } from '../agent-status.js';

export interface AgentContextStores {
  memory: MemoryStore;
  routines: RoutineStore;
  specialists: SpecialistStore;
  candidates: CandidateStoreReader;
  correction: CorrectionCandidateStore;
  toolProfiles: ToolProfileStore;
}

export interface AgentContextMCP {
  tools: Record<string, any>;
  serverNames: string[];
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
   * Per-session snapshot of the most recent PAC critic verdict. Written by
   * sub-agent dispatch sites (`tools/subagent.ts`) and read by the Agent
   * Status overlay (issue #140). Shared by reference with sub-agent /
   * tool-wrapper contexts so a nested PAC run still updates the parent's
   * snapshot.
   */
  verification: VerificationStore;
}

export interface AssembleContextInput {
  config: BernardConfig;
  toolOptions: ToolOptions;
  mcp?: Partial<AgentContextMCP>;
  rag?: RAGStore;
  stores?: Partial<AgentContextStores>;
  provenance?: ProvenanceStore;
  verification?: VerificationStore;
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
    },
    rag: input.rag,
    toolOptions: input.toolOptions,
    provenance: input.provenance ?? new ProvenanceStore(),
    verification: input.verification ?? new VerificationStore(),
  };
}
