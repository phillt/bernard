import type { BernardConfig } from '../config.js';
import type { PolicyInput } from './types.js';

/**
 * Builds a {@link PolicyInput} for tests. Constructs only the
 * `BernardConfig` fields sub-policies currently read (provider, model,
 * reactMode); the rest are filled with safe defaults via a cast so tests
 * stay short.
 */
export function makePolicyInput(overrides?: {
  userInput?: string;
  config?: Partial<BernardConfig>;
  turnIndex?: number;
}): PolicyInput {
  const config = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    ragEnabled: true,
    theme: 'bernard',
    maxSteps: 25,
    reactMode: false,
    subagentPac: true,
    toolDetails: false,
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    correctionEnabled: true,
    promptRewriter: true,
    referenceLookup: true,
    referenceLookupTools: [],
    customProviders: {},
    ...overrides?.config,
  } as BernardConfig;
  return {
    userInput: overrides?.userInput ?? 'hello',
    config,
    turnIndex: overrides?.turnIndex,
  };
}
