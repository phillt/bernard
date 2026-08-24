import type { BernardConfig } from '../../../config.js';
import type { AgentContext } from '../../context.js';

/**
 * Shared fixture for the per-server MCP delegation assertions (#296, #305).
 * Two MCP servers, three raw tools between them — enough to prove that a
 * definition carries `delegate_<server>` tools instead of per-tool schemas,
 * and that the mapping is per-server rather than per-tool.
 *
 * Lives in one place because five definitions must make the identical choice
 * (main, sub, task, specialist, pac-actor); a per-file copy of the context
 * would let one drift without any test noticing.
 */
export function baseConfig(mcpDelegation: boolean): BernardConfig {
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

/** The raw MCP tool names the fixture's servers export. */
export const RAW_MCP_TOOLS = [
  'google__gmail_list',
  'google__gmail_get',
  'slack__post_message',
] as const;

/** The delegate tools that should replace them when delegation is on. */
export const DELEGATE_TOOLS = ['delegate_google', 'delegate_slack'] as const;

export function makeCtx(
  mcpDelegation: boolean,
  overrides: Partial<AgentContext> = {},
): AgentContext {
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
    ...overrides,
  } as unknown as AgentContext;
}
