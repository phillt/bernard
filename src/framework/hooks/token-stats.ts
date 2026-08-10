import type { SpinnerStats, TurnUsageEntry, UsageBucket } from '../../output.js';
import type { ModelTier } from '../../model-policy.js';
import type { AgentHook } from './types.js';
import { telemetryFromUsageRecord } from '../../session-telemetry.js';

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

/**
 * Build a {@link UsageRecord} from a resolved site model + a `generateText`
 * usage payload (#258). The off-loop recorders (pre-turn pipeline, compressor)
 * share this so the bucket coercion and field mapping live in one place.
 */
export function usageRecordFromSite(
  site: SiteModelLike,
  siteName: string,
  usage: { promptTokens: number; completionTokens: number } | undefined,
  providerMetadata?: {
    anthropic?: { cacheCreationInputTokens?: number | null; cacheReadInputTokens?: number | null };
  },
  extra?: { latencyMs?: number; success?: boolean },
): UsageRecord {
  const a = providerMetadata?.anthropic;
  return {
    bucket: bucketForTier(site.tier),
    site: siteName,
    provider: site.provider,
    modelName: site.modelName,
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    cacheReadTokens: a?.cacheReadInputTokens ?? 0,
    cacheWriteTokens: a?.cacheCreationInputTokens ?? 0,
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
  // persisted JSONL. `record` is fail-open, but guard here too so a telemetry
  // bug can never propagate into the model call's hot path.
  if (stats.sessionTelemetry) {
    try {
      const t = stats.sessionTelemetry;
      t.record(telemetryFromUsageRecord(t.sessionId, t.turn, rec));
    } catch {
      // telemetry must never break token accounting
    }
  }
}

/**
 * Fold one step's usage + Anthropic prompt-cache counts (#269 — `number | null`,
 * null on a miss → 0) into the per-turn aggregate + ledger. Shared by both hooks
 * so the record shape lives in one place.
 */
function recordStep(
  stats: SpinnerStats,
  info: HookModelInfo,
  usage: { promptTokens: number; completionTokens: number } | undefined,
  providerMetadata:
    | {
        anthropic?: {
          cacheCreationInputTokens?: number | null;
          cacheReadInputTokens?: number | null;
        };
      }
    | undefined,
  latencyMs?: number,
): void {
  // A step that reports no usage payload isn't a billable model call we can
  // attribute — skip it rather than minting a zero-token ledger row that would
  // inflate the per-model `calls` count (the old guarded odometer did the same).
  if (!usage) return;
  const a = providerMetadata?.anthropic;
  recordTurnUsage(stats, {
    ...info,
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    cacheReadTokens: a?.cacheReadInputTokens ?? 0,
    cacheWriteTokens: a?.cacheCreationInputTokens ?? 0,
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
      if (usage) {
        target.lastStepPromptTokens = usage.promptTokens;
        if (target.spinnerStats) target.spinnerStats.latestPromptTokens = usage.promptTokens;
      }
      if (target.spinnerStats)
        recordStep(target.spinnerStats, info, usage, providerMetadata, latencyMs);
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
        recordStep(target.spinnerStats, info, usage, providerMetadata, latencyMs);
    },
  };
}
