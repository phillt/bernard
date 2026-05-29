import type { PolicyDecision, SubPolicy } from './types.js';

/**
 * Component identifiers used as keys in the per-component model map.
 *
 * Only the components whose call sites currently receive `AgentContext`
 * (and can therefore read `ctx.policyDecision`) are listed: `main` and
 * sub-agents. Issue #170 will extend this set as it threads policy access
 * through the other model-selection call sites (`wrapper`, `cron`,
 * `prompt-rewriter`, `repair`, `reference-resolver`, `specialist-detector`,
 * `context-compression`) — each one gets added together with its wiring so
 * the policy contract never advertises a slot that nothing reads.
 */
export const MODEL_COMPONENTS = ['main', 'sub'] as const;

export type ModelComponent = (typeof MODEL_COMPONENTS)[number];

type Models = NonNullable<PolicyDecision['models']>;

/**
 * Returns the per-component provider/model map. Today: every component
 * mirrors `config.provider` / `config.model`. Issue #170 will replace this
 * with multi-model assignment driven by preferences.
 */
export const modelPolicy: SubPolicy<{ models: Models }> = (input) => {
  const base = { provider: input.config.provider, model: input.config.model };
  const models: Models = {};
  for (const key of MODEL_COMPONENTS) {
    models[key] = base;
  }
  return { models, reason: 'config-default' };
};
