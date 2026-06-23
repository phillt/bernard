import { describe, it, expect } from 'vitest';
import { mainAgentDefinition } from '../main.js';
import type { BernardConfig } from '../../../config.js';
import type { AgentContext } from '../../context.js';
import type { PolicyDecision } from '../../../policy/types.js';

/**
 * `plan` is decoupled from the ReAct enforcement loop: it's available in EVERY
 * mode so the model records a structured plan instead of narrating one in prose.
 * `evaluate` stays gated to ReAct (it's the verification half of the loop).
 */
function baseConfig(coordinatorMode: BernardConfig['coordinatorMode']): BernardConfig {
  return {
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
    coordinatorMode,
    modelMode: 'off',
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
}

function makeCtx(
  coordinatorMode: BernardConfig['coordinatorMode'],
  strategyId?: 'normal' | 'react',
): AgentContext {
  const noopStore = new Proxy({}, { get: () => () => [] });
  return {
    config: baseConfig(coordinatorMode),
    toolOptions: {},
    mcp: { tools: {}, serverNames: [] },
    stores: {
      memory: { clearScratch: () => {} },
      routines: noopStore,
      specialists: noopStore,
      candidates: noopStore,
      toolProfiles: { list: () => [] },
    },
    provenance: undefined,
    verification: { record: () => {} },
    policyDecision: strategyId ? ({ strategyId } as PolicyDecision) : undefined,
  } as unknown as AgentContext;
}

const input = { planStore: {}, systemPrompt: '' } as unknown as Parameters<
  typeof mainAgentDefinition.tools
>[1];

function toolNames(coordinatorMode: BernardConfig['coordinatorMode'], strategyId?: 'normal' | 'react') {
  return Object.keys(mainAgentDefinition.tools(makeCtx(coordinatorMode, strategyId), input));
}

describe('main agent plan/evaluate tool gating', () => {
  it('exposes `plan` in Normal mode (strategy=normal) but not `evaluate`', () => {
    const names = toolNames('auto', 'normal');
    expect(names).toContain('plan');
    expect(names).not.toContain('evaluate');
  });

  it('exposes both `plan` and `evaluate` in ReAct mode (strategy=react)', () => {
    const names = toolNames('auto', 'react');
    expect(names).toContain('plan');
    expect(names).toContain('evaluate');
  });

  it('exposes `plan` even with coordinatorMode off and no policy decision', () => {
    const names = toolNames('off', undefined);
    expect(names).toContain('plan');
    expect(names).not.toContain('evaluate');
  });

  it('exposes both when coordinatorMode is on with no policy decision', () => {
    const names = toolNames('on', undefined);
    expect(names).toContain('plan');
    expect(names).toContain('evaluate');
  });
});
