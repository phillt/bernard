import { describe, it, expect } from 'vitest';
import { buildMainSystemPrompt } from '../main.js';
import type { BernardConfig } from '../../../config.js';
import type { AgentContext } from '../../context.js';
import type { PolicyDecision } from '../../../policy/types.js';

/**
 * Citations must always be on for the main agent, independent of the policy
 * engine — grounding factual claims in checked sources is a core requirement,
 * not a policy-tunable one. The only carve-out is reasoning-family models
 * whose systemSuffix forbids narrating inline markers.
 */
function makeCtx(policyDecision: PolicyDecision | undefined): AgentContext {
  const config: BernardConfig = {
    provider: 'anthropic',
    model: 'claude-test',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    maxSteps: 25,
    ragEnabled: false,
    cacheEnabled: true,
    promptCache: true,
    semanticCache: false,
    theme: 'bernard',
    coordinatorMode: 'off',
    modelMode: 'balanced',
    subagentPac: false,
    toolDetails: false,
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    correctionEnabled: false,
    promptRewriter: false,
    confirmMode: 'auto',
    toolMode: 'write',
    maxConcurrentAgents: 4,
    responseStyle: 'default',
    referenceLookup: false,
    referenceLookupTools: [],
    scratchSubjectThreshold: 0.15,
    conciseMode: false,
    customProviders: {},
  } as unknown as BernardConfig;
  const stores = { toolProfiles: { list: () => [] } } as unknown as AgentContext['stores'];
  return {
    config,
    stores,
    mcp: { tools: {}, serverNames: [] },
    toolOptions: {},
    policyDecision,
    provenance: undefined,
  } as unknown as AgentContext;
}

const baseInput = {
  userInput: 'hello',
  routineSummaries: [],
  specialistSummaries: [],
  specialistMatches: [],
  statsTarget: {} as any,
  planStore: {} as any,
};

const anthropicProfile = { family: 'anthropic', systemSuffix: '' } as ReturnType<
  typeof import('../../../providers/index.js').getModelProfile
>;
const reasoningProfile = { family: 'openai-reasoning', systemSuffix: '' } as ReturnType<
  typeof import('../../../providers/index.js').getModelProfile
>;

describe('buildMainSystemPrompt citations (always on for the main agent)', () => {
  it('includes the Citations block when there is no policy decision at all', () => {
    const prompt = buildMainSystemPrompt(makeCtx(undefined), baseInput, anthropicProfile);
    expect(prompt).toContain('## Citations');
  });

  it('includes the Citations block even if a policy tried to disable it', () => {
    const decision = {
      citations: { requireForFactualClaims: false },
    } as unknown as PolicyDecision;
    const prompt = buildMainSystemPrompt(makeCtx(decision), baseInput, anthropicProfile);
    expect(prompt).toContain('## Citations');
  });

  it('omits inline-marker citations only for reasoning-family models', () => {
    const prompt = buildMainSystemPrompt(makeCtx(undefined), baseInput, reasoningProfile);
    expect(prompt).not.toContain('## Citations');
  });
});
