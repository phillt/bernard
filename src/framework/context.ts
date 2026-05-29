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
}

export interface AssembleContextInput {
  config: BernardConfig;
  toolOptions: ToolOptions;
  mcp?: Partial<AgentContextMCP>;
  rag?: RAGStore;
  stores?: Partial<AgentContextStores>;
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
  };
}
