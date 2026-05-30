import { defineFixture } from '../fixture-schema.js';

/**
 * Issue #170 — per-site model assignment under modelMode. Concrete model
 * strings come from `PROVIDER_TIERS` in `src/model-policy.ts`; if those
 * names change, update here too.
 */
export const modelPolicyFixture = defineFixture({
  name: 'model-policy',
  category: 'model-policy',
  invariants: [
    {
      type: 'model_site_resolves_to_tier',
      config: { provider: 'anthropic', modelMode: 'optimize-tokens' },
      site: 'rewriter',
      expectedModelName: 'claude-haiku-4-5-20251001',
    },
    {
      type: 'model_site_resolves_to_tier',
      config: { provider: 'anthropic', modelMode: 'balanced' },
      site: 'main',
      expectedModelName: 'claude-opus-4-6',
    },
    {
      type: 'model_site_resolves_to_tier',
      config: { provider: 'anthropic', modelMode: 'off' },
      site: 'main',
      expectedModelName: 'claude-sonnet-4-5-20250929',
    },
  ],
});
