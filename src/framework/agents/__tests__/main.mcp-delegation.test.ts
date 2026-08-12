import { describe, it, expect } from 'vitest';
import { mainAgentDefinition } from '../main.js';
import type { BernardConfig } from '../../../config.js';
import type { AgentContext } from '../../context.js';

/**
 * Per-server MCP delegation (#296): with delegation on, the main agent must
 * carry exactly one `delegate_<server>` tool per connected server and NONE of
 * that server's raw per-tool schemas. With delegation off, the raw MCP tools
 * are exposed directly and no delegate tool exists.
 */
function baseConfig(mcpDelegation: boolean): BernardConfig {
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
    mcpDelegation,
    mcpDelegateEscalation: true,
    semanticCache: false,
    theme: 'bernard',
    coordinatorMode: 'off',
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

function makeCtx(mcpDelegation: boolean): AgentContext {
  const noopStore = new Proxy({}, { get: () => () => [] });
  return {
    config: baseConfig(mcpDelegation),
    toolOptions: {},
    mcp: {
      tools: {
        google__gmail_list: { description: 'list gmail' },
        google__gmail_get: { description: 'get email' },
        slack__post_message: { description: 'post to slack' },
      },
      serverNames: ['google', 'slack'],
      serverTools: {
        google: ['google__gmail_list', 'google__gmail_get'],
        slack: ['slack__post_message'],
      },
    },
    stores: {
      memory: { clearScratch: () => {} },
      routines: noopStore,
      specialists: noopStore,
      candidates: noopStore,
      toolProfiles: { list: () => [] },
    },
    provenance: undefined,
    verification: { record: () => {} },
    policyDecision: undefined,
  } as unknown as AgentContext;
}

const input = { planStore: {}, systemPrompt: '' } as unknown as Parameters<
  typeof mainAgentDefinition.tools
>[1];

function toolNames(mcpDelegation: boolean): string[] {
  return Object.keys(mainAgentDefinition.tools(makeCtx(mcpDelegation), input));
}

describe('main agent MCP delegation tool assembly (#296)', () => {
  it('with delegation ON, exposes one delegate_<server> per server and zero raw MCP schemas', () => {
    const names = toolNames(true);
    expect(names).toContain('delegate_google');
    expect(names).toContain('delegate_slack');
    // The whole point: no per-tool MCP schema is resident in the main registry.
    expect(names).not.toContain('google__gmail_list');
    expect(names).not.toContain('google__gmail_get');
    expect(names).not.toContain('slack__post_message');
    // Exactly one delegate per connected server.
    expect(names.filter((n) => n.startsWith('delegate_')).sort()).toEqual([
      'delegate_google',
      'delegate_slack',
    ]);
  });

  it('with delegation OFF, exposes raw MCP tools directly and no delegate tools', () => {
    const names = toolNames(false);
    expect(names).toContain('google__gmail_list');
    expect(names).toContain('google__gmail_get');
    expect(names).toContain('slack__post_message');
    expect(names.filter((n) => n.startsWith('delegate_'))).toEqual([]);
  });
});
