import { defineFixture } from '../fixture-schema.js';

/**
 * Issue #170 — per-site model assignment under modelMode. We assert the cost
 * *tier* each (modelMode, site) resolves to, which is the stable policy
 * contract. The concrete model behind a tier comes from the live model catalog
 * and the per-role lineup matrix (#264), so it drifts whenever a newer model
 * ships — model-name coverage lives in `model-policy.test.ts`, which pins a
 * fixed lineup.
 */
export const modelPolicyFixture = defineFixture({
  name: 'model-policy',
  category: 'model-policy',
  invariants: [
    {
      // optimize-tokens routes classifier-role sites (rewriter) to cheap.
      type: 'model_site_resolves_to_tier',
      config: { provider: 'anthropic', modelMode: 'optimize-tokens' },
      site: 'rewriter',
      expectedTier: 'cheap',
    },
    {
      // balanced keeps the orchestrator (main) on premium.
      type: 'model_site_resolves_to_tier',
      config: { provider: 'anthropic', modelMode: 'balanced' },
      site: 'main',
      expectedTier: 'premium',
    },
    {
      // optimize-performance lifts every site — even the cheap classifier — to premium.
      type: 'model_site_resolves_to_tier',
      config: { provider: 'anthropic', modelMode: 'optimize-performance' },
      site: 'rewriter',
      expectedTier: 'premium',
    },
  ],
});
