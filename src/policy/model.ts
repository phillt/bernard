import type { PolicyDecision, SubPolicy } from './types.js';

/**
 * Component identifiers used as keys in the per-component model map. Listed
 * here (not just in the sub-policy body) so downstream call sites in
 * different files can share the same constants when issue #170 wires them up.
 */
export const MODEL_COMPONENTS = [
  'main',
  'sub',
  'wrapper',
  'cron',
  'prompt-rewriter',
  'repair',
  'reference-resolver',
  'specialist-detector',
  'context-compression',
] as const;

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
