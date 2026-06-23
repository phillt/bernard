import { describe, it, expect, vi } from 'vitest';
import type { SpinnerStats, TurnUsageEntry } from './output.js';

// Deterministic pricing: opus + haiku priced; everything else (custom providers)
// returns null so the `partial` / `n/a` paths are exercised.
vi.mock('./providers/catalog.js', () => ({
  getModelMeta: (provider: string, model: string) => {
    const table: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
      'anthropic|claude-opus-4-8': { inputPerMTok: 15, outputPerMTok: 75 },
      'anthropic|claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5 },
    };
    const p = table[`${provider}|${model}`];
    return p ? ({ pricing: p } as unknown) : null;
  },
}));

const { computeTurnUsageReport, formatUsd, formatTurnCost } = await import('./usage-report.js');

function entry(over: Partial<TurnUsageEntry> & Pick<TurnUsageEntry, 'bucket' | 'provider' | 'modelName' | 'site'>): TurnUsageEntry {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    calls: 1,
    ...over,
  };
}

function statsWith(entries: TurnUsageEntry[]): SpinnerStats {
  const turnLedger = new Map<string, TurnUsageEntry>();
  for (const e of entries) turnLedger.set(`${e.bucket}|${e.provider}|${e.modelName}|${e.site}`, e);
  return {
    startTime: 0,
    turnPromptTokens: 0,
    turnCompletionTokens: 0,
    latestPromptTokens: 0,
    turnCacheReadTokens: 0,
    turnCacheWriteTokens: 0,
    model: 'claude-opus-4-8',
    turnLedger,
  };
}

describe('computeTurnUsageReport (#258)', () => {
  it('returns an empty, zero-cost report for null / empty stats', () => {
    expect(computeTurnUsageReport(null)).toMatchObject({ rows: [], totalCostUsd: 0, partial: false });
    expect(computeTurnUsageReport(statsWith([]))).toMatchObject({ rows: [], partial: false });
  });

  it('merges sites, orders by tier, computes cost, and flags partial', () => {
    const stats = statsWith([
      entry({ bucket: 'premium', provider: 'anthropic', modelName: 'claude-opus-4-8', site: 'main', promptTokens: 1000, completionTokens: 100, calls: 2 }),
      // Same (bucket, provider, model), different site → folds into the opus row.
      entry({ bucket: 'premium', provider: 'anthropic', modelName: 'claude-opus-4-8', site: 'compressor', promptTokens: 500, completionTokens: 50, calls: 1 }),
      entry({ bucket: 'cheap', provider: 'anthropic', modelName: 'claude-haiku-4-5-20251001', site: 'rewriter', promptTokens: 200, completionTokens: 20, calls: 1 }),
      // Custom provider → no catalog pricing → cost null → partial total.
      entry({ bucket: 'pinned', provider: 'ollama', modelName: 'llama3.2', site: 'specialist', promptTokens: 300, completionTokens: 30, calls: 1 }),
    ]);

    const report = computeTurnUsageReport(stats);

    // Three display rows, ordered premium → cheap → pinned.
    expect(report.rows.map((r) => r.bucket)).toEqual(['premium', 'cheap', 'pinned']);

    const opus = report.rows[0]!;
    expect(opus.promptTokens).toBe(1500);
    expect(opus.completionTokens).toBe(150);
    expect(opus.calls).toBe(3);
    expect(opus.sites).toEqual(['compressor', 'main']);
    // 1500/1e6*15 + 150/1e6*75 = 0.0225 + 0.01125 = 0.03375
    expect(opus.costUsd).toBeCloseTo(0.03375, 6);

    expect(report.rows[2]!.costUsd).toBeNull(); // ollama unpriced

    expect(report.totalPromptTokens).toBe(2000);
    expect(report.totalCalls).toBe(5);
    // Total omits the unpriced row but is flagged partial.
    expect(report.totalCostUsd).toBeCloseTo(0.03375 + 0.0003, 6);
    expect(report.partial).toBe(true);
  });

  it('reports totalCostUsd=null when no row is priced', () => {
    const report = computeTurnUsageReport(
      statsWith([entry({ bucket: 'pinned', provider: 'ollama', modelName: 'llama3.2', site: 'main', promptTokens: 100, completionTokens: 10 })]),
    );
    expect(report.totalCostUsd).toBeNull();
    expect(report.partial).toBe(true);
  });
});

describe('formatUsd / formatTurnCost', () => {
  it('scales precision to magnitude', () => {
    expect(formatUsd(1.5)).toBe('$1.50');
    expect(formatUsd(0.07)).toBe('$0.070');
    expect(formatUsd(0.0003)).toBe('$0.0003');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('returns a ` ~$` suffix only when there is priced cost', () => {
    expect(formatTurnCost(null)).toBe('');
    expect(formatTurnCost(statsWith([]))).toBe('');
    const stats = statsWith([
      entry({ bucket: 'premium', provider: 'anthropic', modelName: 'claude-opus-4-8', site: 'main', promptTokens: 1000, completionTokens: 100 }),
    ]);
    expect(formatTurnCost(stats)).toMatch(/^ ~\$/);
  });
});
