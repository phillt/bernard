import type { LanguageModel } from 'ai';
import type { BernardConfig } from './config.js';
import type { Specialist } from './specialists.js';
import {
  PROVIDER_MODELS,
  defaultProviderErrorMessage,
  hasProviderKey,
  resolveProviderAndModel,
  blankToUndefined,
} from './config.js';
import { getModelForConfig, getProviderOptionsForConfig } from './providers/index.js';
import { debugLog } from './logger.js';

/**
 * Logical LLM call sites whose model can be tiered independently when
 * `config.modelMode !== 'off'`. Every `generateText` call in Bernard maps to
 * exactly one site.
 */
export type ModelSite =
  | 'main'
  | 'specialist'
  | 'tool-wrapper'
  | 'rewriter'
  | 'reference-resolver'
  | 'reference-lookup'
  | 'compressor'
  | 'specialist-detector';

export type ModelMode = 'off' | 'optimize-tokens' | 'balanced' | 'optimize-performance';

export type ModelTier = 'cheap' | 'mid' | 'premium';

/**
 * Per-site tier assignment for each `ModelMode`. The tier is mapped to a
 * concrete model via `PROVIDER_TIERS` keyed by the active `config.provider`.
 *
 * `'off'` is intentionally absent here — when the mode is off we short-circuit
 * to `config.provider/config.model` without consulting the tier table.
 */
const TIER_TABLE: Record<Exclude<ModelMode, 'off'>, Record<ModelSite, ModelTier>> = {
  'optimize-tokens': {
    main: 'mid',
    specialist: 'cheap',
    'tool-wrapper': 'cheap',
    compressor: 'cheap',
    'specialist-detector': 'cheap',
    rewriter: 'cheap',
    'reference-resolver': 'cheap',
    'reference-lookup': 'cheap',
  },
  balanced: {
    main: 'premium',
    specialist: 'mid',
    'tool-wrapper': 'mid',
    compressor: 'mid',
    'specialist-detector': 'cheap',
    rewriter: 'cheap',
    'reference-resolver': 'cheap',
    'reference-lookup': 'cheap',
  },
  'optimize-performance': {
    main: 'premium',
    specialist: 'premium',
    'tool-wrapper': 'premium',
    compressor: 'premium',
    'specialist-detector': 'premium',
    rewriter: 'premium',
    'reference-resolver': 'premium',
    'reference-lookup': 'premium',
  },
};

/**
 * Per-provider concrete model for each tier. Model names match entries in
 * `PROVIDER_MODELS` so the chosen value is always one the SDK knows.
 *
 * Custom providers don't appear here — they fall through to `config.model`.
 */
const PROVIDER_TIERS: Record<string, Record<ModelTier, string>> = {
  anthropic: {
    premium: 'claude-opus-4-6',
    mid: 'claude-sonnet-4-5-20250929',
    cheap: 'claude-haiku-4-5-20251001',
  },
  openai: {
    premium: 'gpt-5.2',
    mid: 'gpt-4.1',
    cheap: 'gpt-4.1-mini',
  },
  xai: {
    premium: 'grok-4-1-fast-reasoning',
    mid: 'grok-4-fast-non-reasoning',
    cheap: 'grok-3-mini',
  },
};

/**
 * Result of {@link resolveSiteModel}. `model`/`providerOptions` are ready to
 * pass straight into `generateText({ model, providerOptions, ... })`.
 */
export interface SiteModel {
  model: LanguageModel;
  providerOptions: ReturnType<typeof getProviderOptionsForConfig>;
  provider: string;
  modelName: string;
  /**
   * Where the (provider, model) ultimately came from. `'override'` =
   * invocation-level args; `'specialist'` = persisted specialist record;
   * `'policy'` = tier-table lookup; `'config'` = session global; `'fallback'`
   * = tier lookup attempted but bailed (custom provider, unknown tier, etc.).
   */
  source: 'override' | 'specialist' | 'policy' | 'config' | 'fallback';
  tier?: ModelTier;
}

/** Per-session dedupe of `model-policy:resolve` debug log lines. */
const RESOLVE_LOG_SEEN = new Set<string>();

/**
 * Resolves the effective (provider, model) for a given LLM call site (#170).
 *
 * Precedence (highest to lowest):
 *  1. `opts.overrides.{provider,model}` — invocation-level args (parity with
 *     {@link resolveProviderAndModel}).
 *  2. `opts.specialist.{provider,model}` — persisted specialist record.
 *  3. When `config.modelMode !== 'off'`, the tier table entry for
 *     `(modelMode, site)` mapped through `PROVIDER_TIERS[config.provider]`.
 *  4. `config.provider`/`config.model` — session global.
 *
 * Provider is never crossed automatically — the tier table only selects a
 * model name within the user's active provider. Unknown providers and any
 * other tier-lookup miss safely fall through to step 4 with
 * `source: 'fallback'`.
 */
export function resolveSiteModel(
  config: BernardConfig,
  site: ModelSite,
  opts?: {
    overrides?: { provider?: string; model?: string };
    specialist?: Specialist | undefined;
  },
): SiteModel {
  const override = {
    provider: blankToUndefined(opts?.overrides?.provider),
    model: blankToUndefined(opts?.overrides?.model),
  };
  const specialist = {
    provider: blankToUndefined(opts?.specialist?.provider),
    model: blankToUndefined(opts?.specialist?.model),
  };

  // Steps 1 & 2 — let the existing 3-tier resolver handle override + specialist.
  // If either fired, return that; the policy never overrides an explicit
  // user-supplied or specialist-supplied (provider, model). When the explicit
  // choice points at a provider with no key, throw — matches pre-#170 behavior
  // (specialist.ts / tool-wrapper.ts both relied on this).
  if (override.provider || override.model || specialist.provider || specialist.model) {
    const resolution = resolveProviderAndModel({
      provider: override.provider,
      model: override.model,
      specialistProvider: specialist.provider,
      specialistModel: specialist.model,
      config,
    });
    if (!resolution.ok) {
      throw new Error(
        defaultProviderErrorMessage(resolution.provider, resolution.envVar, resolution.isCustom),
      );
    }
    const source: SiteModel['source'] =
      override.provider || override.model ? 'override' : 'specialist';
    return buildSiteModel(config, resolution.provider, resolution.model, source);
  }

  // Step 3 — tier-table lookup when the policy is active.
  if (config.modelMode && config.modelMode !== 'off') {
    const tier = TIER_TABLE[config.modelMode][site];
    const tierModel = PROVIDER_TIERS[config.provider]?.[tier];
    if (tierModel && hasProviderKey(config, config.provider)) {
      return buildSiteModel(config, config.provider, tierModel, 'policy', site, tier);
    }
    // Custom provider, unknown built-in, or missing key — fall through.
    debugLog('model-policy:fallback', {
      site,
      mode: config.modelMode,
      tier,
      provider: config.provider,
      reason: tierModel ? 'missing-key' : 'no-tier-mapping',
    });
    return buildSiteModel(config, config.provider, config.model, 'fallback', site, tier);
  }

  // Step 4 — passthrough.
  return buildSiteModel(config, config.provider, config.model, 'config');
}

function buildSiteModel(
  config: BernardConfig,
  provider: string,
  modelName: string,
  source: SiteModel['source'],
  site?: ModelSite,
  tier?: ModelTier,
): SiteModel {
  const out: SiteModel = {
    model: getModelForConfig(config, provider, modelName),
    providerOptions: getProviderOptionsForConfig(config, provider),
    provider,
    modelName,
    source,
    tier,
  };
  if (site) {
    const key = `${site}:${provider}:${modelName}:${source}`;
    if (!RESOLVE_LOG_SEEN.has(key)) {
      RESOLVE_LOG_SEEN.add(key);
      debugLog('model-policy:resolve', {
        site,
        mode: config.modelMode,
        tier,
        provider,
        model: modelName,
        source,
      });
    }
  }
  return out;
}

/**
 * Test-only helper to clear the per-session dedupe set so each test sees a
 * fresh "first resolve" log entry.
 */
export function _resetModelPolicyLogCacheForTests(): void {
  RESOLVE_LOG_SEEN.clear();
}
