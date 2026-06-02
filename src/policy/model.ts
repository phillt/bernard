import type { PolicyDecision, SubPolicy } from './types.js';
import { resolveSiteModel } from '../model-policy.js';

/**
 * Component identifiers used as keys in the per-component model map. Maps
 * onto `ModelSite` values (`'main'` → main agent, `'sub'` → specialist/
 * subagent tier). Only the components whose call sites currently receive
 * `AgentContext` and can read `ctx.policyDecision` are listed.
 */
export const MODEL_COMPONENTS = ['main', 'sub'] as const;

export type ModelComponent = (typeof MODEL_COMPONENTS)[number];

type Models = NonNullable<PolicyDecision['models']>;

/**
 * Returns the per-component provider/model map by consulting
 * {@link resolveSiteModel} for each component. With the lineup-based
 * resolver (#170 redesign), this picks the tier slot assigned to the
 * site under the current `modelMode`, freely crossing providers.
 */
export const modelPolicy: SubPolicy<{ models: Models }> = (input) => {
  const main = resolveSiteModel(input.config, 'main');
  const sub = resolveSiteModel(input.config, 'specialist');
  const models: Models = {
    main: { provider: main.provider, model: main.modelName },
    sub: { provider: sub.provider, model: sub.modelName },
  };
  return { models, reason: 'lineup-resolved' };
};
