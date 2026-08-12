import type { BernardConfig } from '../config.js';
import type { PolicyInput } from './types.js';

/**
 * Builds a {@link PolicyInput} for tests. The default config is a fully-typed
 * `BernardConfig` value (no `as` cast) so missing fields surface as compile
 * errors when the type evolves; callers can selectively override any field
 * via `overrides.config`.
 */
export function makePolicyInput(overrides?: {
  userInput?: string;
  config?: Partial<BernardConfig>;
  turnIndex?: number;
  previousUserInput?: string;
}): PolicyInput {
  const baseConfig: BernardConfig = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    ragEnabled: true,
    cacheEnabled: true,
    promptCache: true,
    mcpDelegation: true,
    mcpResultShaping: 'cap',
    mcpResultShapingMaxChars: 8000,
    costGuardrailTokens: 60000,
    semanticCache: false,
    theme: 'bernard',
    maxSteps: 25,
    coordinatorMode: 'off',
    modelMode: 'balanced',
    subagentPac: true,
    toolDetails: false,
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    correctionEnabled: true,
    promptRewriter: true,
    recallFilter: true,
    referenceLookup: true,
    referenceLookupTools: [],
    scratchSubjectThreshold: 0.15,
    conciseMode: true,
    confirmMode: 'auto',
    toolMode: 'read-only',
    maxConcurrentAgents: 4,
    responseStyle: 'default',
    customProviders: {},
    toolPermissions: [],
    skipPermissions: false,
    voiceTts: false,
    voiceBackend: 'auto',
    voiceWarmupMs: 0,
    fullScreen: false,
    mouse: true,
  };
  return {
    userInput: overrides?.userInput ?? 'hello',
    config: { ...baseConfig, ...overrides?.config },
    turnIndex: overrides?.turnIndex,
    previousUserInput: overrides?.previousUserInput,
  };
}
