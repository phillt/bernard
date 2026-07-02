import type { LanguageModel, generateText } from 'ai';
import type { BernardConfig } from './config.js';
import type { Specialist } from './specialists.js';
import {
  defaultProviderErrorMessage,
  hasProviderKey,
  resolveProviderAndModel,
  blankToUndefined,
} from './config.js';
import { getModelForConfig, getProviderOptionsForConfig } from './providers/index.js';
import { modelSupportsTemperature } from './providers/profiles.js';
import { serializeModelParams, type ModelParams } from './providers/model-params.js';
import { loadLineups, resolveActiveLineup, type Lineup } from './lineups.js';
import { DEFAULT_ROLE_TIERS, SITE_ROLE, type RoleId } from './model-roles.js';
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
  | 'recall-filter'
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

/** The AI SDK's `providerOptions` shape (`Record<string, Record<string, JSONValue>>`). */
type SdkProviderOptions = Parameters<typeof generateText>[0]['providerOptions'];

/**
 * Resolves the cost tier for a functional role under the active `modelMode`,
 * data-driven from {@link DEFAULT_ROLE_TIERS} in {@link module:model-roles}.
 * Callers map `site → role` via {@link SITE_ROLE} first (they already need the
 * role for the lineup-slot lookup and the snapshot log). This replaces the
 * legacy hardcoded per-site `TIER_TABLE`; the role tier rows reproduce the old
 * per-site assignments exactly (#264).
 */
function tierForRole(mode: ModelMode, role: RoleId): ModelTier {
  return DEFAULT_ROLE_TIERS[mode][role];
}

/** True when `mode` is a recognized {@link ModelMode}. */
function isKnownMode(mode: unknown): mode is ModelMode {
  return mode === 'optimize-tokens' || mode === 'balanced' || mode === 'optimize-performance';
}

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
  /**
   * Provider-options half (issue #286): the base `getProviderOptionsForConfig`
   * result (OpenAI `strictSchemas`) deep-merged with any per-slot provider
   * params (`providerOptions.<sdk>.reasoningEffort`, Anthropic `thinking`).
   */
  providerOptions: SdkProviderOptions;
  /**
   * Top-level `generateText` params half (issue #286): `temperature`, `topP`,
   * `maxOutputTokens`. Spread into every `generateText` call alongside
   * `providerOptions`. `undefined` when the slot has no top-level params and no
   * per-site baseline applies.
   */
  params?: Record<string, unknown>;
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

/** Canonical list of every site whose model is policy-resolved. */
const ALL_MODEL_SITES: readonly ModelSite[] = [
  'main',
  'specialist',
  'tool-wrapper',
  'rewriter',
  'reference-resolver',
  'reference-lookup',
  'recall-filter',
  'compressor',
  'specialist-detector',
];

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
  const specialist: { provider?: string; model?: string; params?: ModelParams } = {
    provider: blankToUndefined(opts?.specialist?.provider),
    model: blankToUndefined(opts?.specialist?.model),
    params: opts?.specialist?.params,
  };

  // Loaded at most once per resolve — both the pin guard and the tier lookup
  // need it, and `loadLineups()` is an uncached readFileSync + JSON.parse.
  // Function-scoped (not module-memoized) so a `/lineup` edit still takes
  // effect on the next resolve without a process restart.
  let activeLineupCache: Lineup | null = null;
  const getActiveLineup = (): Lineup => (activeLineupCache ??= loadActiveLineup(config));

  // Off-lineup specialist pin guard. A persisted specialist may carry a
  // `provider`/`model` baked in from when it was created — e.g. an
  // `optimize-performance` session against OpenAI. When the user has
  // explicitly chosen an active lineup (`config.activeLineupId` is set) and
  // that lineup doesn't reference the specialist's provider at any tier,
  // the pin is stale: the user has moved on (new lineup, dropped key,
  // exhausted quota under that account). Dropping it lets the dispatch run
  // on the active lineup's tier model instead of stalling on a 429/auth
  // wall from a provider the user no longer relies on. Invocation-level
  // overrides bypass the guard — those are explicit and trump persisted
  // intent. When no `activeLineupId` is set the user hasn't expressed a
  // lineup-level preference, so the pin is the strongest signal and we
  // leave it alone. Custom-provider pins (Ollama, LM Studio, internal
  // proxies) are also exempt: those are deliberate, often privacy- or
  // cost-motivated bindings, and silently rerouting them to a lineup tier
  // would ship a local-model workload to a remote API.
  if (
    config.activeLineupId &&
    !override.provider &&
    !override.model &&
    specialist.provider &&
    !Object.hasOwn(config.customProviders ?? {}, specialist.provider)
  ) {
    const activeLineup = getActiveLineup();
    if (!isProviderInLineup(specialist.provider, activeLineup)) {
      debugLog('model-policy:specialist-off-lineup', {
        site,
        specialistProvider: specialist.provider,
        specialistModel: specialist.model,
        lineupId: activeLineup.id,
        lineupProviders: lineupProviders(activeLineup),
        reason: 'pin-dropped',
      });
      specialist.provider = undefined;
      specialist.model = undefined;
      specialist.params = undefined;
    }
  }

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
    const isOverride = Boolean(override.provider || override.model);
    const source: SiteModel['source'] = isOverride ? 'override' : 'specialist';
    // Pass `site` so `model-policy:resolve` logs fire on override/specialist
    // short-circuits too. Tier/lineup intentionally omitted — those concepts
    // don't apply when the lineup was bypassed. Specialist params ride along on
    // the specialist branch only (an invocation override carries no params).
    return buildSiteModel(
      config,
      resolution.provider,
      resolution.model,
      source,
      site,
      undefined,
      undefined,
      isOverride ? undefined : specialist.params,
    );
  }

  // Step 3 — tier-table lookup against the active lineup. Defensively
  // normalize an unknown/undefined `modelMode` (legacy `'off'`, missing key in
  // test fixtures) to `'balanced'` so resolution never crashes.
  const mode: ModelMode = isKnownMode(config.modelMode) ? config.modelMode : 'balanced';
  const role = SITE_ROLE[site];
  const tier = tierForRole(mode, role);
  const lineup = getActiveLineup();
  const slot = lineup.roles[role][tier];
  if (hasProviderKey(config, slot.provider)) {
    return buildSiteModel(config, slot.provider, slot.model, 'policy', site, tier, lineup, slot.params);
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
 * Model-name string for the `'main'` LLM call site, resolved through the
 * active lineup + model-mode policy. Use this anywhere context-window /
 * compression math needs the model Bernard is actually talking to — the
 * legacy `config.model` base field is only a fallback and goes stale the
 * moment a lineup re-tiers `main` to a different provider/model (#233).
 */
export function resolveMainModel(config: BernardConfig): string {
  return resolveSiteModel(config, 'main').modelName;
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

/** True when any role×tier slot of the lineup is bound to the given provider. */
function isProviderInLineup(provider: string, lineup: Lineup): boolean {
  for (const ladder of Object.values(lineup.roles)) {
    for (const slot of Object.values(ladder)) {
      if (slot.provider === provider) return true;
    }
  }
  return false;
}

/** Unique provider names referenced anywhere in the lineup (debug logging). */
function lineupProviders(lineup: Lineup): string[] {
  const out = new Set<string>();
  for (const ladder of Object.values(lineup.roles)) {
    for (const slot of Object.values(ladder)) out.add(slot.provider);
  }
  return [...out];
}

/**
 * Sites that historically forced `temperature: 0` via the ad-hoc
 * `temperatureParam(...)` spread (now retired). To keep "absent slot params =
 * today's behavior, byte-for-byte" (issue #286 acceptance criterion), we
 * re-inject that baseline here when the model accepts temperature and the slot
 * didn't override it. `compressor` never used `temperatureParam`, so it is
 * deliberately excluded.
 */
const TEMPERATURE_ZERO_SITES: ReadonlySet<ModelSite> = new Set([
  'rewriter',
  'reference-resolver',
  'reference-lookup',
  'recall-filter',
  'specialist-detector',
]);

/**
 * Deep-merges two `providerOptions` shapes one level deep (per-SDK key), so the
 * base OpenAI `{ strictSchemas: false }` survives alongside a serialized
 * `{ reasoningEffort }`. Returns the base reference unchanged when there's
 * nothing to merge (preserves identity for byte-for-byte behavior).
 */
function mergeProviderOptions(
  base: SdkProviderOptions,
  extra: Record<string, unknown>,
): SdkProviderOptions {
  if (Object.keys(extra).length === 0) return base;
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [sdk, opts] of Object.entries(extra)) {
    const existing = out[sdk];
    if (existing && typeof existing === 'object' && opts && typeof opts === 'object') {
      out[sdk] = { ...(existing as Record<string, unknown>), ...(opts as Record<string, unknown>) };
    } else {
      out[sdk] = opts;
    }
  }
  return out as SdkProviderOptions;
}

function buildSiteModel(
  config: BernardConfig,
  provider: string,
  modelName: string,
  source: SiteModel['source'],
  site?: ModelSite,
  tier?: ModelTier,
  lineup?: Lineup,
  slotParams?: ModelParams,
): SiteModel {
  const sdk = config.customProviders?.[provider]?.sdk;
  const serialized = serializeModelParams(provider, modelName, slotParams, sdk);

  // Top-level half (temperature/topP/maxOutputTokens), plus the per-site
  // temperature:0 baseline that preserves the pre-#286 classifier behavior.
  const params: Record<string, unknown> = { ...serialized.params };
  if (
    site &&
    TEMPERATURE_ZERO_SITES.has(site) &&
    params.temperature === undefined &&
    modelSupportsTemperature(modelName, provider)
  ) {
    params.temperature = 0;
  }

  const providerOptions = mergeProviderOptions(
    getProviderOptionsForConfig(config, provider),
    serialized.providerOptions,
  );

  const out: SiteModel = {
    model: getModelForConfig(config, provider, modelName),
    providerOptions,
    params: Object.keys(params).length > 0 ? params : undefined,
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
        params: out.params,
        providerOptions: out.providerOptions,
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

// ---------------------------------------------------------------------------
// Snapshot: lineup-driven baseline for every non-specialist call site.
// ---------------------------------------------------------------------------

export interface SiteModelSnapshotEntry {
  site: ModelSite;
  role: RoleId;
  tier: ModelTier | undefined;
  provider: string;
  model: string;
  source: SiteModel['source'];
}

export interface SiteModelSnapshot {
  modelMode: ModelMode;
  activeLineupId: string | undefined;
  lineup: { id: string; name: string };
  sites: Record<ModelSite, SiteModelSnapshotEntry>;
}

/**
 * Captures the current `{site → (tier, provider, model)}` baseline implied
 * by the active lineup + `config.modelMode`. Specialists and per-call
 * overrides are intentionally excluded — they're per-record, per-call, and
 * out of scope for the lineup-driven view.
 *
 * Pure: does not emit debug logs (uses the dedupe set as a side channel, but
 * does not write a `model-policy:resolve` line for snapshot reads — see
 * implementation note below).
 */
export function snapshotSiteModels(config: BernardConfig): SiteModelSnapshot {
  const mode: ModelMode = isKnownMode(config.modelMode) ? config.modelMode : 'balanced';
  const lineup = loadActiveLineup(config);
  const sites = {} as Record<ModelSite, SiteModelSnapshotEntry>;
  for (const site of ALL_MODEL_SITES) {
    const role = SITE_ROLE[site];
    const tier = tierForRole(mode, role);
    const slot = lineup.roles[role][tier];
    if (hasProviderKey(config, slot.provider)) {
      sites[site] = {
        site,
        role,
        tier,
        provider: slot.provider,
        model: slot.model,
        source: 'policy',
      };
    } else {
      sites[site] = {
        site,
        role,
        tier,
        provider: config.provider,
        model: config.model,
        source: 'fallback',
      };
    }
  }
  return {
    modelMode: mode,
    activeLineupId: config.activeLineupId,
    lineup: { id: lineup.id, name: lineup.name },
    sites,
  };
}

let LAST_SNAPSHOT: SiteModelSnapshot | null = null;

export type SnapshotReason =
  | 'session-start'
  | 'lineup-change'
  | 'model-mode-change'
  | 'profile-switch'
  | 'provider-change';

interface SiteChange {
  site: ModelSite;
  before: { tier: ModelTier | undefined; provider: string; model: string };
  after: { tier: ModelTier | undefined; provider: string; model: string };
}

/**
 * Emits a `model-policy:snapshot` debug event describing the current
 * lineup-driven baseline. `session-start` always emits the full snapshot;
 * subsequent calls emit a diff against the last snapshot (including the
 * no-op `changed: []` case so the user can see that an edit didn't move
 * any binding).
 */
export function logSiteModelSnapshot(config: BernardConfig, reason: SnapshotReason): void {
  const snapshot = snapshotSiteModels(config);
  if (LAST_SNAPSHOT === null || reason === 'session-start') {
    debugLog('model-policy:snapshot', { reason, snapshot });
    LAST_SNAPSHOT = snapshot;
    return;
  }
  const before = LAST_SNAPSHOT;
  const changed: SiteChange[] = [];
  for (const site of ALL_MODEL_SITES) {
    const a = before.sites[site];
    const b = snapshot.sites[site];
    if (a.provider !== b.provider || a.model !== b.model || a.tier !== b.tier) {
      changed.push({
        site,
        before: { tier: a.tier, provider: a.provider, model: a.model },
        after: { tier: b.tier, provider: b.provider, model: b.model },
      });
    }
  }
  debugLog('model-policy:snapshot', {
    reason,
    changed,
    modeBefore: before.modelMode,
    modeAfter: snapshot.modelMode,
    lineupBefore: before.lineup,
    lineupAfter: snapshot.lineup,
  });
  LAST_SNAPSHOT = snapshot;
}

/** Test-only helper: clears the LAST_SNAPSHOT cache. */
export function _resetSnapshotCacheForTests(): void {
  LAST_SNAPSHOT = null;
}
