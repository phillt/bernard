import { describe, it, expect } from 'vitest';
import { buildMainSystemPrompt } from '../main.js';
import type { AgentContext } from '../../context.js';
import { makeTestContext } from '../../../__tests__/agent-context.js';
import { makePolicyInput } from '../../../policy/test-helpers.js';
import type { PolicyDecision } from '../../../policy/types.js';

/**
 * Citations must always be on for the main agent, independent of the policy
 * engine — grounding factual claims in checked sources is a core requirement,
 * not a policy-tunable one. The only carve-out is reasoning-family models
 * whose systemSuffix forbids narrating inline markers.
 */
// Config through `makePolicyInput`, the repo's one cast-free `BernardConfig`
// builder — this file hand-wrote a thirty-line literal that bypassed it, so a
// new config field defaulted here silently instead of failing to compile (#318).
function makeCtx(policyDecision: PolicyDecision | undefined): AgentContext {
  return makeTestContext({
    config: { ...makePolicyInput().config, model: 'claude-test', ragEnabled: false },
    policyDecision,
  });
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
