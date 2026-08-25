import { describe, it, expect } from 'vitest';
import { mainAgentDefinition } from '../main.js';
import type { BernardConfig } from '../../../config.js';
import type { AgentContext } from '../../context.js';
import type { PolicyDecision } from '../../../policy/types.js';
import { toolsOf } from './_mcp-delegation-fixture.js';

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

async function toolNames(
  coordinatorMode: BernardConfig['coordinatorMode'],
  strategyId?: 'normal' | 'react',
): Promise<string[]> {
  return Object.keys(
    await toolsOf(mainAgentDefinition, makeCtx(coordinatorMode, strategyId), input),
  );
}

describe('main agent plan/evaluate tool gating', () => {
  // `evaluate` membership is SESSION-stable (#269): present whenever ReAct is
  // possible this session (coordinatorMode !== 'off'), independent of the
  // per-turn strategy. This keeps the tool block byte-identical across turns so
  // the Anthropic prompt cache holds. `plan` is always present.

  it('in `auto` mode, exposes `plan` AND `evaluate` regardless of the per-turn strategy', async () => {
    // Even on a Normal turn, evaluate stays present so the tool block doesn't
    // flip between turns (cache stability).
    const normalTurn = await toolNames('auto', 'normal');
    expect(normalTurn).toContain('plan');
    expect(normalTurn).toContain('evaluate');

    const reactTurn = await toolNames('auto', 'react');
    expect(reactTurn).toContain('plan');
    expect(reactTurn).toContain('evaluate');
  });

  it('with coordinatorMode off, exposes `plan` but never `evaluate`', async () => {
    const names = await toolNames('off', undefined);
    expect(names).toContain('plan');
    expect(names).not.toContain('evaluate');
  });

  it('exposes both when coordinatorMode is on with no policy decision', async () => {
    const names = await toolNames('on', undefined);
    expect(names).toContain('plan');
    expect(names).toContain('evaluate');
  });

  it('tool set is identical across Normal and ReAct turns within a session (cache stability)', async () => {
    expect((await toolNames('auto', 'normal')).sort()).toEqual(
      (await toolNames('auto', 'react')).sort(),
    );
  });
});
