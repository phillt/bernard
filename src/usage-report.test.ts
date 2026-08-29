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
      // Real gateway rates, so the reconciliation suite below can be checked
      // against xAI's actual usage export rather than invented numbers.
      'xai|grok-4.5': {
        inputPerMTok: 2,
        outputPerMTok: 6,
        cacheReadPerMTok: 0.3,
      },
      'xai|grok-4.3': {
        inputPerMTok: 1.25,
        outputPerMTok: 2.5,
        cacheReadPerMTok: 0.2,
      },
    };
    const p = table[`${provider}|${model}`];
    return p ? ({ pricing: p } as unknown) : null;
  },
}));

const {
  computeTurnUsageReport,
  formatUsd,
  formatCostSuffix,
  formatTiers,
  priceUsageUsd,
  priceUsageBreakdown,
  costUpperBoundNote,
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

describe('formatUsd / formatCostSuffix', () => {
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
    // `prompt` is the TOTAL (1800), of which 800 were cache reads — so 1000 pay
    // full rate and 800 pay the cache rate. Every token billed exactly once.
    const b = priceUsageBreakdown('anthropic', 'claude-opus-4-8', 1800, 100, {
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

  it('no double charge: cache tokens are a SUBSET of prompt, so they are subtracted', () => {
    // The counts reaching here are normalized (`normalizeUsage`): `prompt` is the
    // total and cache counts are subsets. Pricing the full 1000 at input rate AND
    // 800 at cache rate would bill 1800 tokens for a 1000-token call — the
    // over-charge that made a measured xAI session read 3x its real cost.
    const b = priceUsageBreakdown('anthropic', 'claude-opus-4-8', 1000, 0, {
      cacheReadTokens: 800,
    })!;
    expect(b.inputCostUsd).toBeCloseTo((200 / 1e6) * 15, 12); // 1000 - 800
    expect(b.cacheReadCostUsd).toBeCloseTo((800 / 1e6) * 1.5, 12);
  });

  it('never bills negative when cache counts exceed the prompt total', () => {
    // Defensive: a malformed payload must clamp to zero, not credit money back.
    const b = priceUsageBreakdown('anthropic', 'claude-opus-4-8', 100, 0, {
      cacheReadTokens: 900,
    })!;
    expect(b.inputCostUsd).toBe(0);
    expect(b.totalCostUsd).toBeGreaterThan(0);
  });

  it('entire input cached: no ordinary input cost remains', () => {
    // A turn served entirely from cache: total prompt 1000, all of it cache-read.
    const b = priceUsageBreakdown('anthropic', 'claude-opus-4-8', 1000, 0, {
      cacheReadTokens: 1000,
    })!;
    expect(b.inputCostUsd).toBe(0);
    expect(b.cacheReadCostUsd).toBeCloseTo((1000 / 1e6) * 1.5, 12);
    expect(b.totalCostUsd).toBeCloseTo((1000 / 1e6) * 1.5, 12);
  });

  it('cache write: priced at the cache-write rate independently', () => {
    const b = priceUsageBreakdown('anthropic', 'claude-opus-4-8', 1000, 0, {
      cacheWriteTokens: 1000,
    })!;
    expect(b.cacheWriteCostUsd).toBeCloseTo((1000 / 1e6) * 18.75, 12);
    expect(b.totalCostUsd).toBeCloseTo((1000 / 1e6) * 18.75, 12);
  });

  it('missing cache pricing: cached tokens stay at the FULL input rate, not free', () => {
    // haiku in the mock has NO cache rates. Publishing no cache price means
    // offering no discount, so those tokens bill as ordinary input. Carving them
    // out of the full-rate remainder anyway would value them at zero — a ~5x
    // under-report for the 10 catalogued OpenAI models in this position
    // (`*-pro`, `gpt-oss-*`, `gpt-4-turbo`) that all report cachedPromptTokens.
    const b = priceUsageBreakdown('anthropic', 'claude-haiku-4-5-20251001', 6200, 100, {
      cacheReadTokens: 5000,
      cacheWriteTokens: 200,
    })!;
    expect(b.cacheReadCostUsd).toBe(0);
    expect(b.cacheWriteCostUsd).toBe(0);
    // All 6200 prompt tokens priced at the input rate — none discounted away.
    expect(b.totalCostUsd).toBeCloseTo((6200 / 1e6) * 1 + (100 / 1e6) * 5, 12);
  });

  it('subtracts only the cache categories the catalog can price', () => {
    // opus has a cache-READ rate but the mock gives it a cache-WRITE rate too;
    // use a model with read-only pricing to pin the asymmetry: grok-4.5 has
    // cacheReadPerMTok and no cacheWritePerMTok.
    const b = priceUsageBreakdown('xai', 'grok-4.5', 1000, 0, {
      cacheReadTokens: 600,
      cacheWriteTokens: 100,
    })!;
    // read (600) is discounted and carved out; write (100) has no rate, so it
    // stays in the full-rate remainder: 1000 - 600 = 400 at $2/M.
    expect(b.inputCostUsd).toBeCloseTo((400 / 1e6) * 2, 12);
    expect(b.cacheReadCostUsd).toBeCloseTo((600 / 1e6) * 0.3, 12);
    expect(b.cacheWriteCostUsd).toBe(0);
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
        promptTokens: 3100,
        completionTokens: 100,
        cacheReadTokens: 2000,
        cacheWriteTokens: 100,
      }),
    ]);
    const report = computeTurnUsageReport(stats);
    // 3100 total - 2000 read - 100 write = 1000 at full input rate.
    const expected =
      (1000 / 1e6) * 15 + (100 / 1e6) * 75 + (2000 / 1e6) * 1.5 + (100 / 1e6) * 18.75;
    expect(report.totalCostUsd).toBeCloseTo(expected, 12);
  });
});

describe('formatTiers', () => {
  it('renders a single tier as-is', () => {
    expect(formatTiers(new Set(['mid'] as const))).toBe('mid');
  });

  it('joins multiple tiers in spend order, not insertion order', () => {
    // A layer straddles tiers — `main` runs premium on a turn's first step and
    // mid on continuations — and the joined form is what makes a lineup whose
    // premium and mid slots name the SAME model visible in the breakdown.
    // This is the SINGLE owner of display order; the accumulator stores a Set.
    expect(formatTiers(new Set(['mid', 'premium'] as const))).toBe('premium+mid');
    expect(formatTiers(new Set(['cheap', 'premium', 'mid'] as const))).toBe('premium+mid+cheap');
  });

  it('returns empty for no tiers so the column stays blank', () => {
    expect(formatTiers(new Set())).toBe('');
  });
});

describe('reconciles against a real provider bill (xAI, 2026-08-22)', () => {
  // Ground truth from xAI's own usage export for session 2026-08-22-6f3c1d41:
  // 1,430,770 tokens billed at $0.916754. Bernard's token accounting already
  // matched to 0.22%; only the pricing was wrong, because cached tokens were
  // charged at the full input rate. This pins the fix to measured reality.
  const GROK_45_IN = 1_315_000;
  const GROK_45_OUT = 4_300;
  const GROK_43_IN = 108_000;
  const GROK_43_OUT = 282;
  const ACTUAL_USD = 0.916754;
  // The hit rate implied by solving the catalog rates against the actual bill.
  const CACHE_HIT = 0.798;

  function priceSession(hitRate: number): number {
    const rows: Array<[string, number, number]> = [
      ['grok-4.5', GROK_45_IN, GROK_45_OUT],
      ['grok-4.3', GROK_43_IN, GROK_43_OUT],
    ];
    return rows.reduce(
      (sum, [model, inTok, outTok]) =>
        sum +
        (priceUsageUsd('xai', model, inTok, outTok, {
          cacheReadTokens: Math.round(inTok * hitRate),
          cacheWriteTokens: 0,
        }) ?? 0),
      0,
    );
  }

  // NOTE: CACHE_HIT is FITTED to this bill, so this is a calibration check, not
  // an independent verification — it confirms the pricing model can reproduce
  // the bill, not that the hit rate was 79.8%. The overstatement and monotonicity
  // assertions below are the ones that would catch a regression.
  it('can reproduce the actual bill (calibration, fitted hit rate)', () => {
    const estimate = priceSession(CACHE_HIT);
    expect(Math.abs(estimate - ACTUAL_USD) / ACTUAL_USD).toBeLessThan(0.01);
  });

  it('reproduces the 3x overstatement when no cache is credited', () => {
    // What Bernard reported before the fix — the regression this guards.
    const uncredited = priceSession(0);
    expect(uncredited / ACTUAL_USD).toBeGreaterThan(2.9);
  });

  it('is monotonic: crediting more cache never costs more', () => {
    expect(priceSession(1)).toBeLessThan(priceSession(CACHE_HIT));
    expect(priceSession(CACHE_HIT)).toBeLessThan(priceSession(0));
  });
});

describe('costUpperBoundNote', () => {
  it('marks a majority-legacy total', () => {
    expect(costUpperBoundNote(10, 6)).toBe(' (upper bound)');
    expect(costUpperBoundNote(10, 5)).toBe(' (upper bound)');
  });

  it('stays quiet below the majority threshold', () => {
    expect(costUpperBoundNote(10, 4.9)).toBe('');
  });

  it('stays quiet when there is nothing priced to qualify', () => {
    expect(costUpperBoundNote(0, 0)).toBe('');
    expect(costUpperBoundNote(0, 5)).toBe('');
    expect(costUpperBoundNote(10, 0)).toBe('');
  });
});
