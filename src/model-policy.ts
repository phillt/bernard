import type { LanguageModel } from 'ai';
import type { BernardConfig } from './config.js';
import type { Specialist } from './specialists.js';
import {
  defaultProviderErrorMessage,
  hasProviderKey,
  resolveProviderAndModel,
  blankToUndefined,
} from './config.js';
import { getModelForConfig, getProviderOptionsForConfig } from './providers/index.js';
import { loadLineups, resolveActiveLineup, type Lineup } from './lineups.js';
import { debugLog } from './logger.js';

/**
 * Logical LLM call sites whose model can be tiered independently when
 * the active `config.modelMode`. Every `generateText` call in Bernard maps
 * to exactly one site.
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

/**
 * Three-value runtime mode (#170, redesigned). The legacy `'off'` value is
 * gone — every active call site now flows through the active lineup. Stored
 * `'off'` is migrated to `'optimize-performance'` on first load (see
 * {@link normalizeStoredModelMode}).
 */
export type ModelMode = 'optimize-tokens' | 'balanced' | 'optimize-performance';

export type ModelTier = 'cheap' | 'mid' | 'premium';

/**
 * Per-site tier assignment for each `ModelMode`. The tier maps to a concrete
 * `(provider, model)` via the user's active lineup (`src/lineups.ts`).
 */
const TIER_TABLE: Record<ModelMode, Record<ModelSite, ModelTier>> = {
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
 * Normalizes any modelMode-shaped value read from disk or env. Returns the
 * canonical runtime mode, or `undefined` for inputs that don't match. Migrates
 * legacy `'off'` → `'optimize-performance'` so existing users keep their
 * previously chosen model in the premium tier of the seeded lineup.
 */
export function normalizeStoredModelMode(v: unknown): ModelMode | undefined {
  if (v === 'optimize-tokens' || v === 'balanced' || v === 'optimize-performance') return v;
  if (v === 'off') return 'optimize-performance';
  return undefined;
}

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
 * Resolves the effective (provider, model) for a given LLM call site.
 *
 * Precedence (highest to lowest):
 *  1. `opts.overrides.{provider,model}` — invocation-level args (parity with
 *     {@link resolveProviderAndModel}).
 *  2. `opts.specialist.{provider,model}` — persisted specialist record.
 *  3. The tier-table entry for `(modelMode, site)` mapped through the
 *     **active lineup** (`src/lineups.ts`). When the lineup slot's provider
 *     has no key, we fall through.
 *  4. `config.provider`/`config.model` — last-resort fallback (used when the
 *     lineup file is missing/corrupt, or the resolved slot lacks a key).
 *
 * Lineups are user-defined and may freely mix providers across tiers, so
 * "active provider" is no longer a concept here — each tier slot carries its
 * own provider.
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
  // The policy never overrides an explicit user-supplied or specialist-supplied
  // (provider, model). When the explicit choice points at a provider with no
  // key, throw — matches pre-#170 behavior (specialist.ts / tool-wrapper.ts
  // both relied on this).
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

  // Step 3 — tier-table lookup against the active lineup. Defensively
  // normalize an unknown/undefined `modelMode` (legacy `'off'`, missing key in
  // test fixtures) to `'balanced'` so resolution never crashes.
  const mode: ModelMode = TIER_TABLE[config.modelMode] ? config.modelMode : 'balanced';
  const tier = TIER_TABLE[mode][site];
  const lineup = loadActiveLineup(config);
  const slot = lineup[tier];
  if (hasProviderKey(config, slot.provider)) {
    return buildSiteModel(config, slot.provider, slot.model, 'policy', site, tier, lineup);
  }
  // Lineup slot points at a provider with no key — fall through to the
  // session-global so the turn doesn't crash. This is the only "silent
  // degradation" path left, and it's loud in the debug log.
  debugLog('model-policy:fallback', {
    site,
    mode,
    tier,
    lineupId: lineup.id,
    slotProvider: slot.provider,
    slotModel: slot.model,
    reason: 'missing-key',
  });
  return buildSiteModel(config, config.provider, config.model, 'fallback', site, tier, lineup);
}

/**
 * Loads the active lineup once per call. Cheap — `loadLineups()` is a
 * single small JSON read; we don't memoize so a `/lineup` edit takes effect
 * on the next turn without process restart.
 */
function loadActiveLineup(config: BernardConfig): Lineup {
  const lineups = loadLineups();
  return resolveActiveLineup(lineups, config.activeLineupId, config.provider);
}

function buildSiteModel(
  config: BernardConfig,
  provider: string,
  modelName: string,
  source: SiteModel['source'],
  site?: ModelSite,
  tier?: ModelTier,
  lineup?: Lineup,
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
    const key = `${site}:${provider}:${modelName}:${source}:${lineup?.id ?? '-'}`;
    if (!RESOLVE_LOG_SEEN.has(key)) {
      RESOLVE_LOG_SEEN.add(key);
      debugLog('model-policy:resolve', {
        site,
        mode: config.modelMode,
        tier,
        provider,
        model: modelName,
        source,
        lineupId: lineup?.id,
        lineupName: lineup?.name,
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
