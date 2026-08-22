import type { SpinnerStats, TurnUsageEntry, UsageBucket } from '../../output.js';
import type { ModelTier } from '../../model-policy.js';
import type { AgentHook, CacheMetadata } from './types.js';

/**
 * Single home for the "a model with no tier is bucketed as `pinned`" rule
 * (#258). Used by `run.ts` and by every pre-turn / compressor recorder so the
 * coercion can't drift across call sites.
 */
export function bucketForTier(tier: ModelTier | undefined): UsageBucket {
  return tier ?? 'pinned';
}

/**
 * Target object whose fields the hook mutates in place. Implemented today
 * by the {@link Agent} instance (`this.lastStepPromptTokens`,
 * `this.spinnerStats`); tests can pass a plain object.
 */
export interface TokenStatsTarget {
  lastStepPromptTokens: number;
  spinnerStats: SpinnerStats | null;
}

/**
 * Identifies which model/tier a step's tokens should be attributed to (#258).
 * Supplied by `run.ts` (which has the resolved model in scope) when installing
 * the hooks, and by the pre-turn / compressor recorders.
 */
export interface HookModelInfo {
  bucket: UsageBucket;
  site: string;
  provider: string;
  modelName: string;
}

/** A single usage observation to fold into the per-turn aggregate + ledger. */
export interface UsageRecord extends HookModelInfo {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Wall-clock for this call/step, when the site can measure it (#session-telemetry). */
  latencyMs?: number;
  /** False on a recorded failed/aborted call. Defaults to true when omitted. */
  success?: boolean;
}

/**
 * Callback that folds a usage observation into the per-turn ledger (#258).
 * Passed (type-only, so no runtime import cycle) into the pre-turn pipeline and
 * the compressor so their off-loop LLM calls count toward the turn total. The
 * REPL / Agent wires it to `(rec) => recordTurnUsage(spinnerStats, rec)`.
 */
export type UsageRecorder = (rec: UsageRecord) => void;

/** The fields of a resolved `SiteModel` that ledger attribution needs. */
interface SiteModelLike {
  tier?: ModelTier;
  provider: string;
  modelName: string;
}

/** Token counts for one call, normalized across providers. */
export interface NormalizedUsage {
  /**
   * TOTAL prompt tokens for the call — cached ones INCLUDED. This is the number
   * that reconciles against a provider's billing dashboard, which is why it is
   * the normal form rather than the uncached remainder.
   */
  promptTokens: number;
  completionTokens: number;
  /** Cache-read tokens. A SUBSET of {@link promptTokens}. */
  cacheReadTokens: number;
  /** Cache-write tokens. A SUBSET of {@link promptTokens}. */
  cacheWriteTokens: number;
}

/**
 * Normalizes a step's usage into {@link NormalizedUsage}, hiding a genuine
 * disagreement between providers about what "prompt tokens" means:
 *
 * - **Anthropic** reports `input_tokens` EXCLUDING cache reads/writes, which the
 *   SDK maps to `usage.promptTokens`. The cache counts arrive separately, so the
 *   true total is the sum.
 * - **OpenAI-compatible** (`@ai-sdk/openai`, `@ai-sdk/xai`, and every custom
 *   provider wrapping them) reports `prompt_tokens` INCLUDING cached tokens, with
 *   `prompt_tokens_details.cached_tokens` a subset surfaced as `cachedPromptTokens`.
 *
 * Reading only the Anthropic shape made every cached xAI/OpenAI token bill at the
 * full input rate — a 3x cost overstatement, pinned against a real provider bill
 * by the reconciliation suite in `src/usage-report.test.ts`.
 *
 * Cache-write is Anthropic-only; implicit caching has no write charge, so it is 0
 * for the OpenAI-compatible shape.
 */
export function normalizeUsage(
  usage: { promptTokens: number; completionTokens: number } | undefined,
  providerMetadata: CacheMetadata | undefined,
): NormalizedUsage {
  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;

  const anthropic = providerMetadata?.anthropic;
  if (anthropic) {
    // `null` means "cache miss", not "unknown" — both fold to 0.
    const cacheReadTokens = anthropic.cacheReadInputTokens ?? 0;
    const cacheWriteTokens = anthropic.cacheCreationInputTokens ?? 0;
    return {
      promptTokens: promptTokens + cacheReadTokens + cacheWriteTokens,
      completionTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
  }

  // Scan namespaces rather than checking known provider names, so a custom
  // provider (which gets its own metadata key) is handled without config.
  const cached = Object.values(providerMetadata ?? {}).find(
    (ns) => ns?.cachedPromptTokens != null,
  )?.cachedPromptTokens;
  return {
    promptTokens,
    completionTokens,
    // Clamped: a subset can never exceed the total it belongs to, and an
    // over-large value would price negative input if it slipped through.
    cacheReadTokens: Math.max(0, Math.min(cached ?? 0, promptTokens)),
    cacheWriteTokens: 0,
  };
}

/**
 * Build a {@link UsageRecord} from a resolved site model + a `generateText`
 * usage payload (#258). The off-loop recorders (pre-turn pipeline, compressor)
 * share this so the bucket coercion and field mapping live in one place.
 */
export function usageRecordFromSite(
  site: SiteModelLike,
  siteName: string,
  usage: { promptTokens: number; completionTokens: number } | undefined,
  providerMetadata?: CacheMetadata,
  extra?: { latencyMs?: number; success?: boolean },
): UsageRecord {
  return {
    bucket: bucketForTier(site.tier),
    site: siteName,
    provider: site.provider,
    modelName: site.modelName,
    ...normalizeUsage(usage, providerMetadata),
    latencyMs: extra?.latencyMs,
    success: extra?.success,
  };
}

/**
 * The single per-turn accumulation point (#258). Bumps the aggregate ↑/↓ +
 * cache odometers **and** the per-tier/model `turnLedger` entry so the two can
 * never drift — the aggregate is, by construction, the sum of the ledger rows.
 * Every token-producing site (main step, sub step, pre-turn pipeline,
 * compressor) routes through here.
 */
export function recordTurnUsage(stats: SpinnerStats, rec: UsageRecord): void {
  // Defensive: stats constructed before #258 (or by a terse test stub) may lack
  // the ledger Map. Seed it rather than throw.
  if (!stats.turnLedger) stats.turnLedger = new Map<string, TurnUsageEntry>();
  const cacheRead = rec.cacheReadTokens ?? 0;
  const cacheWrite = rec.cacheWriteTokens ?? 0;

  stats.turnPromptTokens += rec.promptTokens;
  stats.turnCompletionTokens += rec.completionTokens;
  stats.turnCacheReadTokens += cacheRead;
  stats.turnCacheWriteTokens += cacheWrite;

  const key = `${rec.bucket}|${rec.provider}|${rec.modelName}|${rec.site}`;
  let entry = stats.turnLedger.get(key);
  if (!entry) {
    entry = {
      bucket: rec.bucket,
      site: rec.site,
      provider: rec.provider,
      modelName: rec.modelName,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      calls: 0,
    };
    stats.turnLedger.set(key, entry);
  }
  entry.promptTokens += rec.promptTokens;
  entry.completionTokens += rec.completionTokens;
  entry.cacheReadTokens += cacheRead;
  entry.cacheWriteTokens += cacheWrite;
  entry.calls += 1;

  // Durable, cross-turn telemetry (#session-telemetry). The turn ledger above is
  // cleared each turn; this sink survives to power the session breakdown + the
  // persisted JSONL. `recordUsage` is fail-open, but guard here too so a telemetry
  // bug can never propagate into the model call's hot path.
  try {
    stats.sessionTelemetry?.recordUsage(rec);
  } catch {
    // telemetry must never break token accounting
  }
}

/**
 * A {@link UsageRecorder} bound to a target that owns a `spinnerStats` — folds
 * each usage observation into that target's live per-turn ledger + session sink
 * when stats are mounted (no-op otherwise). The one home for the off-loop
 * recorder wiring, shared by the REPL pre-turn pipeline and the sub-agent
 * repair path so the presence-guard can't drift.
 */
export function makeUsageRecorder(target: { spinnerStats: SpinnerStats | null }): UsageRecorder {
  return (rec) => {
    if (target.spinnerStats) recordTurnUsage(target.spinnerStats, rec);
  };
}

/**
 * Fold one step's usage + Anthropic prompt-cache counts (#269 — `number | null`,
 * null on a miss → 0) into the per-turn aggregate + ledger. Shared by both hooks
 * so the record shape lives in one place.
 */
function recordStep(
  stats: SpinnerStats,
  info: HookModelInfo,
  normalized: NormalizedUsage | null,
  latencyMs?: number,
): void {
  // A step that reports no usage payload isn't a billable model call we can
  // attribute — skip it rather than minting a zero-token ledger row that would
  // inflate the per-model `calls` count (the old guarded odometer did the same).
  if (!normalized) return;
  recordTurnUsage(stats, {
    ...info,
    ...normalized,
    latencyMs,
    // A step that finished with a usage payload succeeded; failed dispatches
    // throw before `onStepFinish` and never reach here. Dispatch-trace ids are
    // captured centrally in `telemetryFromUsageRecord` from the ambient context.
    success: true,
  });
}

/**
 * Full per-step accounting for the **main agent**. After each step:
 *  - writes the latest prompt-token count onto `target.lastStepPromptTokens`
 *    (used downstream for compression-headroom calculations);
 *  - sets `latestPromptTokens` — the main agent's current context size, which
 *    the status-bar gauge measures;
 *  - records the step's usage into the per-turn aggregate + ledger, attributed
 *    to the supplied {@link HookModelInfo} (#258).
 *
 * Only the main agent installs this hook. Sub-agents / tool-wrappers / PAC
 * phases use {@link tokenTotalsHook} instead so their steps add to the per-turn
 * odometer/ledger without disturbing the gauge or the compression math (#234).
 */
export function tokenStatsHook(target: TokenStatsTarget, info: HookModelInfo): AgentHook {
  // Fresh per-dispatch closure — `lastStepAt` measures inter-step wall time for
  // the session telemetry latency roll-up (the cleanest signal without TTFT
  // plumbing). Captured at hook creation ≈ dispatch start.
  let lastStepAt = Date.now();
  return {
    onStepFinish: ({ usage, providerMetadata }) => {
      const now = Date.now();
      const latencyMs = now - lastStepAt;
      lastStepAt = now;
      // Normalize once and feed both consumers, so the gauge and the ledger
      // cannot disagree about the same step. The gauge wants the REAL prompt
      // size — cached tokens included — because reading `usage.promptTokens`
      // raw under-reports by the cached share on Anthropic (whose
      // `input_tokens` excludes cache), collapsing a near-full window to a few
      // thousand tokens whenever the cache is warm.
      const normalized = usage ? normalizeUsage(usage, providerMetadata) : null;
      if (normalized) {
        target.lastStepPromptTokens = normalized.promptTokens;
        if (target.spinnerStats) target.spinnerStats.latestPromptTokens = normalized.promptTokens;
      }
      if (target.spinnerStats) recordStep(target.spinnerStats, info, normalized, latencyMs);
    },
  };
}

/**
 * Totals-only accounting for **non-main** dispatches (sub-agent, task,
 * specialist, tool-wrapper, PAC phases). Adds each step's usage to the per-turn
 * aggregate + ledger so the turn reflects its *full* cost — including work
 * offloaded to ephemeral sub-agents — but deliberately leaves `latestPromptTokens`
 * (the main-agent context gauge) and `lastStepPromptTokens` (main-agent
 * compression headroom) untouched. No-ops when `spinnerStats` is null, so cron /
 * headless dispatches (no stats target) cost nothing (#234).
 */
export function tokenTotalsHook(target: TokenStatsTarget, info: HookModelInfo): AgentHook {
  let lastStepAt = Date.now();
  return {
    onStepFinish: ({ usage, providerMetadata }) => {
      const now = Date.now();
      const latencyMs = now - lastStepAt;
      lastStepAt = now;
      if (target.spinnerStats)
        recordStep(
          target.spinnerStats,
          info,
          usage ? normalizeUsage(usage, providerMetadata) : null,
          latencyMs,
        );
    },
  };
}
