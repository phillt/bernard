import type { SpinnerStats, TurnUsageEntry, UsageBucket } from './output.js';
import type { BernardConfig } from './config.js';
import { getModelMeta } from './providers/catalog.js';
import { LINEUP_TIERS, loadLineups, resolveActiveLineup, type LineupTier, type LineupSlot } from './lineups.js';

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

/** Row display order: by tier (premium → cheap → pinned), then larger prompt spend first. */
function compareUsageRows(a: UsageReportRow, b: UsageReportRow): number {
  return BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || b.promptTokens - a.promptTokens;
}

/**
 * Estimated USD cost of a (prompt, completion) token spend on a given model from
 * catalog pricing ($/M tok), or `null` when the model isn't in the catalog
 * (custom provider / unknown). Shared by the per-turn report and one-off pricing
 * (e.g. `/compact` compaction spend).
 */
export function priceUsageUsd(provider: string, modelName: string, prompt: number, completion: number): number | null {
  const meta = getModelMeta(provider, modelName);
  if (!meta) return null;
  return (prompt / 1_000_000) * meta.pricing.inputPerMTok + (completion / 1_000_000) * meta.pricing.outputPerMTok;
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
      costUsd: priceUsageUsd(row.provider, row.modelName, row.promptTokens, row.completionTokens),
    }))
    .sort(compareUsageRows);

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
 * Representative `(provider, model)` for each cost tier (premium/mid/cheap) of
 * the active lineup, taken from the headline `orchestrator` role. The Usage &
 * Cost panel uses this to label the **zero-usage** tier rows it always shows, so
 * the high-end tier is visible even in modes that never reach it (e.g.
 * `optimize-tokens` never assigns `premium`). Does a single small lineup-file
 * read — deliberately kept out of the hot pure path (`computeTurnUsageReport`)
 * and resolved once at panel-open time by the caller.
 */
export function representativeTierModels(config: BernardConfig): Record<LineupTier, LineupSlot> {
  const lineup = resolveActiveLineup(loadLineups(), config.activeLineupId, config.provider);
  // `RoleSlots` is already `Record<LineupTier, LineupSlot>`, so the orchestrator
  // ladder is exactly the shape we want (and stays correct if a tier is added).
  return lineup.roles.orchestrator;
}

/**
 * Ensures every lineup cost tier (premium/mid/cheap) is represented in the
 * display rows: for any tier with no usage this turn, appends a synthetic
 * **zero-row** (`calls: 0`, all tokens 0) labelled with that tier's
 * representative model, then re-sorts the combined set by tier order. Purely
 * presentational — it does NOT touch the report totals (which are computed
 * upstream over the real ledger only). Zero-rows are identified downstream by
 * `calls === 0`. `pinned` rows (specialist pins) pass through untouched; only
 * the three lineup tiers are zero-filled.
 */
export function fillTierRows(
  rows: UsageReportRow[],
  tierModels: Record<LineupTier, LineupSlot>,
): UsageReportRow[] {
  const filled = [...rows];
  for (const tier of LINEUP_TIERS) {
    if (rows.some((r) => r.bucket === tier)) continue;
    const slot = tierModels[tier];
    filled.push({
      bucket: tier,
      provider: slot.provider,
      modelName: slot.model,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      calls: 0,
      costUsd: null,
      sites: [],
    });
  }
  return filled.sort(compareUsageRows);
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
