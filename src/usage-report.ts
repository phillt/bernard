import type { SpinnerStats, TurnUsageEntry, UsageBucket } from './output.js';
import { getModelMeta } from './providers/catalog.js';

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

/** Tier display order, premium first; `pinned` (off-lineup) trails. */
const BUCKET_ORDER: Record<UsageBucket, number> = { premium: 0, mid: 1, cheap: 2, pinned: 3 };

/** Per-row cost from catalog pricing ($/M tok), or null when the model is unknown. */
function rowCostUsd(provider: string, modelName: string, prompt: number, completion: number): number | null {
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
    totalCostUsd: 0,
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
      costUsd: rowCostUsd(row.provider, row.modelName, row.promptTokens, row.completionTokens),
    }))
    .sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || b.promptTokens - a.promptTokens);

  const priced = rows.filter((r) => r.costUsd !== null);
  return {
    rows,
    totalPromptTokens: rows.reduce((s, r) => s + r.promptTokens, 0),
    totalCompletionTokens: rows.reduce((s, r) => s + r.completionTokens, 0),
    totalCacheReadTokens: rows.reduce((s, r) => s + r.cacheReadTokens, 0),
    totalCalls: rows.reduce((s, r) => s + r.calls, 0),
    totalCostUsd: priced.length > 0 ? priced.reduce((s, r) => s + (r.costUsd ?? 0), 0) : null,
    partial: priced.length < rows.length,
  };
}

/** Format a USD amount with precision scaled to magnitude (e.g. `$0.07`, `$0.0042`, `$1.20`). */
export function formatUsd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return '$0.00';
}

/**
 * Compact `~$cost` suffix for the StatusBar odometer (#258). Returns `''` when
 * there's no priced cost yet (no tokens, or only unpriced custom-provider models)
 * so the bar stays clean.
 */
export function formatTurnCost(stats: SpinnerStats | null): string {
  const report = computeTurnUsageReport(stats);
  if (report.totalCostUsd === null || report.totalCostUsd <= 0) return '';
  return ` ~${formatUsd(report.totalCostUsd)}`;
}
