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
 * Cost tiers in spend order, most expensive first — derived from the canonical
 * `LINEUP_TIERS` so it can't drift if a tier is renamed or added; `pinned`
 * (off-lineup) trails. Fixes the display order of {@link formatTiers}.
 */
export const TIER_ORDER: readonly UsageBucket[] = [...LINEUP_TIERS, 'pinned'];

/** Rank per tier, for sorting rows. Same order as {@link TIER_ORDER}. */
const BUCKET_ORDER: Record<UsageBucket, number> = Object.fromEntries(
  TIER_ORDER.map((tier, i) => [tier, i]),
) as Record<UsageBucket, number>;

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
 * **Token semantics:** `prompt` is the TOTAL prompt tokens for the call, with
 * `cacheRead` / `cacheWrite` as SUBSETS of it — the normal form produced by
 * `normalizeUsage` (`src/framework/hooks/token-stats.ts`), which reconciles the
 * providers' disagreement about whether cached tokens are already counted in the
 * prompt. The full-rate portion is therefore `prompt - cacheRead - cacheWrite`,
 * and every token is billed exactly once at its own rate.
 *
 * Callers MUST pass normalized counts. Adding the cache categories on top of an
 * inclusive `prompt` over-bills the cached share at ~6x its real rate; the
 * reconciliation suite in `usage-report.test.ts` pins this against a real bill.
 *
 * A model that lacks a cache rate keeps that category at the **full input rate**
 * rather than carving it out. Publishing no cache price means offering no
 * discount, so those tokens really do bill as ordinary input — 10 catalogued
 * OpenAI models (the `*-pro` tier, `gpt-oss-*`, `gpt-4-turbo`, …) report
 * `cachedPromptTokens` while publishing no `input_cache_read`, and subtracting
 * their cached share would silently value it at zero.
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
  // Cache counts are subsets of `prompt`, but only carve out the categories the
  // catalog can actually price — an un-priced category stays in the full-rate
  // remainder instead of becoming free. Clamped so malformed input can never
  // produce a negative cost.
  const discountedRead = p.cacheReadPerMTok != null ? cacheRead : 0;
  const discountedWrite = p.cacheWritePerMTok != null ? cacheWrite : 0;
  const fullRateTokens = Math.max(0, prompt - discountedRead - discountedWrite);
  const inputCostUsd = (fullRateTokens / 1_000_000) * p.inputPerMTok;
  const outputCostUsd = (completion / 1_000_000) * p.outputPerMTok;
  const cacheReadCostUsd = (discountedRead / 1_000_000) * (p.cacheReadPerMTok ?? 0);
  const cacheWriteCostUsd = (discountedWrite / 1_000_000) * (p.cacheWritePerMTok ?? 0);
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
 * `cache` counts — SUBSETS of `prompt` — to price cache-read (~0.1×) and
 * cache-write (~1.25×) tokens at their own rates. See
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

/**
 * Anything carrying the five fields pricing needs. Deliberately structural
 * rather than a named record type, so the per-turn report row, a
 * `ModelCallTelemetry`, and a raw `UsageRecord` all satisfy it without importing
 * each other.
 */
export interface PriceableUsage {
  provider: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * {@link priceUsageUsd} for a record-shaped value.
 *
 * The five-argument-plus-options call was written out at three sites (the
 * per-turn report, telemetry minting, and re-pricing on read) and had already
 * drifted cosmetically between them. One spelling means adding a priced token
 * category is one edit, not a search.
 */
export function priceUsageForRecord(rec: PriceableUsage): number | null {
  return priceUsageUsd(rec.provider, rec.modelName, rec.promptTokens, rec.completionTokens, {
    cacheReadTokens: rec.cacheReadTokens,
    cacheWriteTokens: rec.cacheWriteTokens,
  });
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
      costUsd: priceUsageForRecord(row),
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

/**
 * Renders the tiers a rolled-up row spans, e.g. `premium` or `premium+mid`.
 * A layer is not pinned to one tier, so a single label would have to lie; the
 * joined form is what reveals a layer straddling tiers (and, when those tiers
 * name the same model, that the tiering is buying nothing).
 */
export function formatTiers(tiers: ReadonlySet<UsageBucket>): string {
  return TIER_ORDER.filter((t) => tiers.has(t)).join('+');
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
 * Cost cell for a rolled-up aggregate (session telemetry): `~$x` when priced,
 * `n/a` when every folded call was unpriced, else `~$0.00`. Single home for the
 * priced/unpriced convention shared by the `/usage` Session view and the
 * `bernard usage` CLI so they can't drift.
 */
export function formatAggCost(costUsd: number, hasUnpriced: boolean): string {
  if (costUsd > 0) return `~${formatUsd(costUsd)}`;
  return hasUnpriced ? 'n/a' : '~$0.00';
}

/**
 * Legacy-cost share above which a rolled-up total is an upper bound rather than
 * an estimate. A majority: below this the overstatement is a rounding error,
 * and a qualifier that fires on mixed sessions trains readers to ignore it.
 */
const UPPER_BOUND_SHARE = 0.5;

/**
 * ` (upper bound)` when most of a rolled-up total came from records that
 * predate cache-aware token capture, else `''`.
 *
 * Those records carry `cacheReadTokens: 0` whether or not input was cached, so
 * every cached token is re-billed at the full input rate — a ~4x overstatement
 * on one measured session (headline `~$27.87` against ~$6.95 of real spend).
 *
 * Thresholded on the legacy share of **cost**, not of calls: 300 cheap legacy
 * `think` calls beside 5 expensive modern ones would stamp a total that is
 * essentially right, which is exactly how a caveat becomes noise.
 *
 * Kept out of {@link formatAggCost} deliberately — three of that helper's call
 * sites are live-session or per-row figures where legacy records cannot occur
 * by construction, so widening it would add an always-false argument and churn
 * a width-constrained StatusBar cell.
 */
export function costUpperBoundSuffix(totalCostUsd: number, legacyCostUsd: number): string {
  if (totalCostUsd <= 0 || legacyCostUsd <= 0) return '';
  return legacyCostUsd / totalCostUsd >= UPPER_BOUND_SHARE ? ' (upper bound)' : '';
}

/** Cost cell for a single call whose cost may be unknown: `~$x` or `n/a`. */
export function formatCallCost(costUsd: number | null): string {
  // A single call's cost is the agg convention with "unknown" == null cost.
  return formatAggCost(costUsd ?? 0, costUsd == null);
}
