import { describe, it, expect, vi } from 'vitest';
import type { SpinnerStats, TurnUsageEntry } from './output.js';

// Deterministic pricing: opus (WITH cache rates) + haiku (WITHOUT cache rates)
// priced; everything else (custom providers) returns null so the `partial` /
// `n/a` paths and the "missing cache pricing" fallback are exercised.
vi.mock('./providers/catalog.js', () => ({
  getModelMeta: (provider: string, model: string) => {
    const table: Record<
      string,
      {
        inputPerMTok: number;
        outputPerMTok: number;
        cacheReadPerMTok?: number;
        cacheWritePerMTok?: number;
      }
    > = {
      'anthropic|claude-opus-4-8': {
        inputPerMTok: 15,
        outputPerMTok: 75,
        cacheReadPerMTok: 1.5,
        cacheWritePerMTok: 18.75,
      },
      // Intentionally no cache rates → exercises the deterministic $0 fallback.
      'anthropic|claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5 },
    };
    const p = table[`${provider}|${model}`];
    return p ? ({ pricing: p } as unknown) : null;
  },
}));

const {
  computeTurnUsageReport,
  formatUsd,
  formatTurnCost,
  formatCostSuffix,
  priceUsageUsd,
  priceUsageBreakdown,
} = await import('./usage-report.js');

function entry(
  over: Partial<TurnUsageEntry> &
    Pick<TurnUsageEntry, 'bucket' | 'provider' | 'modelName' | 'site'>,
): TurnUsageEntry {
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
    sessionCostUsd: 0,
  };
}

describe('computeTurnUsageReport (#258)', () => {
  it('returns an empty, zero-cost report for null / empty stats', () => {
    expect(computeTurnUsageReport(null)).toMatchObject({
      rows: [],
      totalCostUsd: null,
      partial: false,
    });
    expect(computeTurnUsageReport(statsWith([]))).toMatchObject({ rows: [], partial: false });
  });

  it('merges sites, orders by tier, computes cost, and flags partial', () => {
    const stats = statsWith([
      entry({
        bucket: 'premium',
        provider: 'anthropic',
        modelName: 'claude-opus-4-8',
        site: 'main',
        promptTokens: 1000,
        completionTokens: 100,
        calls: 2,
      }),
      // Same (bucket, provider, model), different site → folds into the opus row.
      entry({
        bucket: 'premium',
        provider: 'anthropic',
        modelName: 'claude-opus-4-8',
        site: 'compressor',
        promptTokens: 500,
        completionTokens: 50,
        calls: 1,
      }),
      entry({
        bucket: 'cheap',
        provider: 'anthropic',
        modelName: 'claude-haiku-4-5-20251001',
        site: 'rewriter',
        promptTokens: 200,
        completionTokens: 20,
        calls: 1,
      }),
      // Custom provider → no catalog pricing → cost null → partial total.
      entry({
        bucket: 'pinned',
        provider: 'ollama',
        modelName: 'llama3.2',
        site: 'specialist',
        promptTokens: 300,
        completionTokens: 30,
        calls: 1,
      }),
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
      statsWith([
        entry({
          bucket: 'pinned',
          provider: 'ollama',
          modelName: 'llama3.2',
          site: 'main',
          promptTokens: 100,
          completionTokens: 10,
        }),
      ]),
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

  it('formatCostSuffix returns a bare ~$ fragment, empty for null/zero/negative', () => {
    expect(formatCostSuffix(0.07)).toBe('~$0.070');
    expect(formatCostSuffix(null)).toBe('');
    expect(formatCostSuffix(undefined)).toBe('');
    expect(formatCostSuffix(0)).toBe('');
    expect(formatCostSuffix(-1)).toBe('');
  });

  it('returns a ` ~$` suffix only when there is priced cost', () => {
    expect(formatTurnCost(null)).toBe('');
    expect(formatTurnCost(statsWith([]))).toBe('');
    const stats = statsWith([
      entry({
        bucket: 'premium',
        provider: 'anthropic',
        modelName: 'claude-opus-4-8',
        site: 'main',
        promptTokens: 1000,
        completionTokens: 100,
      }),
    ]);
    expect(formatTurnCost(stats)).toMatch(/^ ~\$/);
  });
});

// Rates (per M tok) for anthropic|claude-opus-4-8 in the mock above:
//   input 15 · output 75 · cache-read 1.5 · cache-write 18.75
describe('cache-aware pricing (priceUsageBreakdown / priceUsageUsd)', () => {
  it('no cache: uses ordinary input/output rates only', () => {
    const b = priceUsageBreakdown('anthropic', 'claude-opus-4-8', 1000, 500)!;
    expect(b.inputCostUsd).toBeCloseTo((1000 / 1e6) * 15, 12);
    expect(b.outputCostUsd).toBeCloseTo((500 / 1e6) * 75, 12);
    expect(b.cacheReadCostUsd).toBe(0);
    expect(b.cacheWriteCostUsd).toBe(0);
    expect(b.totalCostUsd).toBeCloseTo((1000 / 1e6) * 15 + (500 / 1e6) * 75, 12);
  });

  it('partial cache: prices uncached input, cache-read, and output separately', () => {
    // Anthropic `promptTokens` is uncached input (disjoint from cache), so the
    // 1000 prompt tokens and 800 cache-read tokens are DIFFERENT tokens.
    const b = priceUsageBreakdown('anthropic', 'claude-opus-4-8', 1000, 100, {
      cacheReadTokens: 800,
    })!;
    expect(b.inputCostUsd).toBeCloseTo((1000 / 1e6) * 15, 12);
    expect(b.cacheReadCostUsd).toBeCloseTo((800 / 1e6) * 1.5, 12);
    expect(b.outputCostUsd).toBeCloseTo((100 / 1e6) * 75, 12);
    expect(b.totalCostUsd).toBeCloseTo(
      (1000 / 1e6) * 15 + (800 / 1e6) * 1.5 + (100 / 1e6) * 75,
      12,
    );
  });

  it('no double charge: does NOT subtract cache-read from prompt (Anthropic disjoint)', () => {
    // Regression guard for the "M is a subset of N" worry. For Anthropic the
    // cache tokens are NOT a subset of promptTokens — they are disjoint — so the
    // full 1000 prompt tokens are priced at input rate AND 800 at cache-read
    // rate (1800 distinct tokens), never 200 or 1800-at-input.
    const b = priceUsageBreakdown('anthropic', 'claude-opus-4-8', 1000, 0, {
      cacheReadTokens: 800,
    })!;
    expect(b.inputCostUsd).toBeCloseTo((1000 / 1e6) * 15, 12); // full prompt, not (1000-800)
    expect(b.cacheReadCostUsd).toBeCloseTo((800 / 1e6) * 1.5, 12);
  });

  it('entire input cached: no ordinary input cost remains', () => {
    // A turn served entirely from cache: input_tokens (prompt) = 0, cache-read = 1000.
    const b = priceUsageBreakdown('anthropic', 'claude-opus-4-8', 0, 0, {
      cacheReadTokens: 1000,
    })!;
    expect(b.inputCostUsd).toBe(0);
    expect(b.cacheReadCostUsd).toBeCloseTo((1000 / 1e6) * 1.5, 12);
    expect(b.totalCostUsd).toBeCloseTo((1000 / 1e6) * 1.5, 12);
  });

  it('cache write: priced at the cache-write rate independently', () => {
    const b = priceUsageBreakdown('anthropic', 'claude-opus-4-8', 0, 0, {
      cacheWriteTokens: 1000,
    })!;
    expect(b.cacheWriteCostUsd).toBeCloseTo((1000 / 1e6) * 18.75, 12);
    expect(b.totalCostUsd).toBeCloseTo((1000 / 1e6) * 18.75, 12);
  });

  it('missing cache pricing: cache tokens contribute $0, input/output still priced', () => {
    // haiku in the mock has NO cache rates → deterministic, backward compatible.
    const b = priceUsageBreakdown('anthropic', 'claude-haiku-4-5-20251001', 1000, 100, {
      cacheReadTokens: 5000,
      cacheWriteTokens: 200,
    })!;
    expect(b.cacheReadCostUsd).toBe(0);
    expect(b.cacheWriteCostUsd).toBe(0);
    expect(b.totalCostUsd).toBeCloseTo((1000 / 1e6) * 1 + (100 / 1e6) * 5, 12);
  });

  it('unknown model → null (unknown, never fabricated)', () => {
    expect(
      priceUsageBreakdown('ollama', 'llama3.2', 1000, 100, { cacheReadTokens: 50 }),
    ).toBeNull();
    expect(priceUsageUsd('ollama', 'llama3.2', 1000, 100)).toBeNull();
  });

  it('priceUsageUsd equals the breakdown total (single pricing path)', () => {
    const cache = { cacheReadTokens: 800, cacheWriteTokens: 50 };
    const total = priceUsageUsd('anthropic', 'claude-opus-4-8', 1000, 100, cache);
    const b = priceUsageBreakdown('anthropic', 'claude-opus-4-8', 1000, 100, cache)!;
    expect(total).toBeCloseTo(b.totalCostUsd, 12);
  });

  it('computeTurnUsageReport folds cache-read cost into the row estimate', () => {
    const stats = statsWith([
      entry({
        bucket: 'premium',
        provider: 'anthropic',
        modelName: 'claude-opus-4-8',
        site: 'main',
        promptTokens: 1000,
        completionTokens: 100,
        cacheReadTokens: 2000,
        cacheWriteTokens: 100,
      }),
    ]);
    const report = computeTurnUsageReport(stats);
    const expected =
      (1000 / 1e6) * 15 + (100 / 1e6) * 75 + (2000 / 1e6) * 1.5 + (100 / 1e6) * 18.75;
    expect(report.totalCostUsd).toBeCloseTo(expected, 12);
  });
});
