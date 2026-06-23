import { describe, it, expect } from 'vitest';
import { buildMainSystemPrompt } from '../main.js';
import { RESPONSE_STYLE_PROMPTS, type ResponseStyle } from '../../../agent-prompt.js';
import type { BernardConfig } from '../../../config.js';
import type { AgentContext } from '../../context.js';

/**
 * `buildMainSystemPrompt` reads `ctx.config.responseStyle` and (optionally)
 * `ctx.policyDecision?.concise?.enabled`, `ctx.stores.toolProfiles`, etc.
 * Build the smallest possible ctx that exercises the response-style branch
 * without dragging in the full Agent class — we only care about the style
 * block being appended (or not).
 */
function makeCtx(style: ResponseStyle): AgentContext {
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
    responseStyle: style,
    referenceLookup: false,
    referenceLookupTools: [],
    scratchSubjectThreshold: 0.15,
    conciseMode: false,
    customProviders: {},
  };
  const stores = {
    toolProfiles: { list: () => [] },
  } as unknown as AgentContext['stores'];
  return {
    config,
    stores,
    mcp: { tools: {}, serverNames: [] },
    toolOptions: {},
    policyDecision: undefined,
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

const profile = {
  family: 'anthropic',
  systemSuffix: '',
} as ReturnType<typeof import('../../../providers/index.js').getModelProfile>;

describe('buildMainSystemPrompt response-style injection (#133)', () => {
  it('omits any style block when responseStyle = "default"', () => {
    const prompt = buildMainSystemPrompt(makeCtx('default'), baseInput, profile);
    expect(prompt).not.toContain('## Response Style');
  });

  it('appends the matching block for every non-default style', () => {
    const styles: ResponseStyle[] = [
      'detailed',
      'short',
      'step-by-step',
      'simple',
      'high-level',
      'critical',
      'creative',
    ];
    for (const style of styles) {
      const prompt = buildMainSystemPrompt(makeCtx(style), baseInput, profile);
      const expected = RESPONSE_STYLE_PROMPTS[style];
      expect(expected).not.toBeNull();
      expect(prompt).toContain(expected as string);
    }
  });

  it('places the style block after the base system prompt', () => {
    const prompt = buildMainSystemPrompt(makeCtx('critical'), baseInput, profile);
    const baseIdx = prompt.indexOf('# Identity');
    const styleIdx = prompt.indexOf('## Response Style: Critical');
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(styleIdx).toBeGreaterThan(baseIdx);
  });
});
