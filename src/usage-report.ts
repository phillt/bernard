import type { SpinnerStats, TurnUsageEntry, UsageBucket } from './output.js';
import { getModelMeta } from './providers/catalog.js';
import { LINEUP_TIERS } from './lineups.js';

/**
 * Per-turn token + cost insights (#258). Aggregates the {@link SpinnerStats}
 * `turnLedger` (keyed by bucket|provider|model|site) into one display row per
 * `(bucket, provider, model)` and joins each against catalog pricing to estimate
 * dollar cost. Pure + sync — safe to call from a React render, the StatusBar
 * poll, or the `turn-stats` debug log. Cost is an **estimate**: catalog pricing
 * ignores prompt-caching discounts, batch pricing, and reasoning-token quirks
 * (hence the `~` everywhere it surfaces).
 */
export interface UsageReportRow {
  bucket: UsageBucket;
  provider: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  /** Estimated USD for this row, or `null` when the model has no catalog pricing. */
  costUsd: number | null;
  /** Logical sites that contributed to this row (e.g. `main`, `rewriter`). */
  sites: string[];
}

export interface UsageReport {
  rows: UsageReportRow[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadTokens: number;
  totalCalls: number;
  /** Sum of priced rows, or `null` when no row had catalog pricing. */
  totalCostUsd: number | null;
  /** True when at least one row lacked pricing, so the total omits some cost. */
  partial: boolean;
}

/**
 * Tier display order, derived from the canonical `LINEUP_TIERS` (premium first)
 * so it can't drift if a tier is renamed/added; `pinned` (off-lineup) trails.
 */
const BUCKET_ORDER: Record<UsageBucket, number> = {
  ...Object.fromEntries(LINEUP_TIERS.map((tier, i) => [tier, i])),
  pinned: LINEUP_TIERS.length,
} as Record<UsageBucket, number>;

/** Disjoint cache-token counts for a call (Anthropic prompt-cache, #269). */
export interface CacheTokens {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Per-category USD decomposition of a single call's cost. Sums to `totalCostUsd`. */
export interface UsageCostBreakdown {
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  totalCostUsd: number;
}

/**
 * Deterministic per-category cost decomposition for one call, or `null` when the
 * model has no catalog pricing (custom / unknown provider — cost stays unknown,
 * never fabricated).
 *
 * **Token semantics (verified against `@ai-sdk/anthropic@1.2.12`):** the AI SDK
 * maps `promptTokens` from Anthropic's `input_tokens`, which is **disjoint** from
 * `cache_read_input_tokens` / `cache_creation_input_tokens`. So `prompt` here is
 * ordinary *uncached* input — it must NOT have cache tokens subtracted from it,
 * and pricing `prompt` + `cacheRead` + `cacheWrite` counts every token exactly
 * once (no double charge). This is the only provider whose cache tokens Bernard
 * currently tracks; providers that fold cached tokens into their prompt count
 * would need normalization at the accounting boundary before reaching here.
 *
 * A model that lacks a cache rate contributes **$0** for that category (preserves
 * the pre-cache behavior; never invents a price).
 */
export function priceUsageBreakdown(
  provider: string,
  modelName: string,
  prompt: number,
  completion: number,
  cache?: CacheTokens,
): UsageCostBreakdown | null {
  const meta = getModelMeta(provider, modelName);
  if (!meta) return null;
  const p = meta.pricing;
  const cacheRead = cache?.cacheReadTokens ?? 0;
  const cacheWrite = cache?.cacheWriteTokens ?? 0;
  const inputCostUsd = (prompt / 1_000_000) * p.inputPerMTok;
  const outputCostUsd = (completion / 1_000_000) * p.outputPerMTok;
  const cacheReadCostUsd =
    p.cacheReadPerMTok != null ? (cacheRead / 1_000_000) * p.cacheReadPerMTok : 0;
  const cacheWriteCostUsd =
    p.cacheWritePerMTok != null ? (cacheWrite / 1_000_000) * p.cacheWritePerMTok : 0;
  return {
    inputCostUsd,
    outputCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheWriteCostUsd,
  };
}

/**
 * Estimated total USD for a call's token spend from catalog pricing ($/M tok),
 * or `null` when the model isn't in the catalog. Cache-aware (#269): pass the
 * disjoint `cache` counts to price cache-read (~0.1×) and cache-write (~1.25×)
 * tokens at their own rates. `prompt` is ordinary uncached input — see
 * {@link priceUsageBreakdown} for the token semantics. Shared by the per-turn
 * report, session telemetry, and one-off `/compact` pricing.
 */
export function priceUsageUsd(
  provider: string,
  modelName: string,
  prompt: number,
  completion: number,
  cache?: CacheTokens,
): number | null {
  return priceUsageBreakdown(provider, modelName, prompt, completion, cache)?.totalCostUsd ?? null;
}

export function computeTurnUsageReport(stats: SpinnerStats | null): UsageReport {
  const empty: UsageReport = {
    rows: [],
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCacheReadTokens: 0,
    totalCalls: 0,
    // `null`, not 0: an empty ledger has no pricing data, matching the
    // all-unpriced path below. `null` = "nothing priced"; 0 = "priced at zero".
    totalCostUsd: null,
    partial: false,
  };
  if (!stats?.turnLedger || stats.turnLedger.size === 0) return empty;

  // Collapse the per-site ledger into one row per (bucket, provider, model).
  const merged = new Map<string, UsageReportRow & { siteSet: Set<string> }>();
  for (const entry of stats.turnLedger.values() as IterableIterator<TurnUsageEntry>) {
    const key = `${entry.bucket}|${entry.provider}|${entry.modelName}`;
    let row = merged.get(key);
    if (!row) {
      row = {
        bucket: entry.bucket,
        provider: entry.provider,
        modelName: entry.modelName,
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        calls: 0,
        costUsd: null,
        sites: [],
        siteSet: new Set<string>(),
      };
      merged.set(key, row);
    }
    row.promptTokens += entry.promptTokens;
    row.completionTokens += entry.completionTokens;
    row.cacheReadTokens += entry.cacheReadTokens;
    row.cacheWriteTokens += entry.cacheWriteTokens;
    row.calls += entry.calls;
    row.siteSet.add(entry.site);
  }

  const rows: UsageReportRow[] = Array.from(merged.values())
    .map(({ siteSet, ...row }) => ({
      ...row,
      sites: Array.from(siteSet).sort(),
      costUsd: priceUsageUsd(row.provider, row.modelName, row.promptTokens, row.completionTokens, {
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
      }),
    }))
    .sort(
      (a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || b.promptTokens - a.promptTokens,
    );

  // Single pass over the (small) row set for every total.
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCalls = 0;
  let costSum = 0;
  let pricedCount = 0;
  for (const r of rows) {
    totalPromptTokens += r.promptTokens;
    totalCompletionTokens += r.completionTokens;
    totalCacheReadTokens += r.cacheReadTokens;
    totalCalls += r.calls;
    if (r.costUsd !== null) {
      costSum += r.costUsd;
      pricedCount += 1;
    }
  }
  return {
    rows,
    totalPromptTokens,
    totalCompletionTokens,
    totalCacheReadTokens,
    totalCalls,
    totalCostUsd: pricedCount > 0 ? costSum : null,
    partial: pricedCount < rows.length,
  };
}

/** Format a USD amount with precision scaled to magnitude (e.g. `$0.07`, `$0.0042`, `$1.20`). */
export function formatUsd(n: number): string {
  // Non-finite (NaN/Infinity from a malformed catalog price) or non-positive →
  // the neutral '$0.00' rather than '$Infinity' / '$NaN' garbage in the UI.
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

/**
 * Bare `~$cost` cost fragment (no leading space/separator) for a raw amount, or
 * `''` when there's nothing priced to show (null/zero/negative). The single home
 * for the `~$` convention + zero-guard so the StatusBar turn cell, the StatusBar
 * session cell, and the per-turn transcript label can't drift (#258).
 */
export function formatCostSuffix(n: number | null | undefined): string {
  return n != null && n > 0 ? `~${formatUsd(n)}` : '';
}

/**
 * Compact ` ~$cost` suffix for the StatusBar odometer (#258). Returns `''` when
 * there's no priced cost yet (no tokens, or only unpriced custom-provider models)
 * so the bar stays clean.
 */
export function formatTurnCost(stats: SpinnerStats | null): string {
  const cost = formatCostSuffix(computeTurnUsageReport(stats).totalCostUsd);
  return cost ? ` ${cost}` : '';
}
