import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runWithDispatchId } from './framework/dispatch-context.js';

// Deterministic pricing (mirrors usage-report.test.ts): opus + haiku priced;
// everything else returns null so the unpriced path is exercised.
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
      'anthropic|claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5 },
    };
    const p = table[`${provider}|${model}`];
    return p ? ({ pricing: p } as unknown) : null;
  },
}));

const {
  SessionTelemetry,
  telemetryFromUsageRecord,
  aggregateRecords,
  PRICING_VERSION,
  formatSessionUsageLines,
  telemetryEnabled,
} = await import('./session-telemetry.js');
const { priceUsageUsd } = await import('./usage-report.js');

type Rec = import('./session-telemetry.js').ModelCallTelemetry;

function rec(over: Partial<Rec> & Pick<Rec, 'site' | 'provider' | 'modelName'>): Rec {
  return {
    ts: '2026-08-07T00:00:00.000Z',
    sessionId: 's1',
    turn: 1,
    bucket: 'premium',
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    success: true,
    ...over,
  };
}

function store() {
  return new SessionTelemetry('s1', { persist: false });
}

describe('telemetryFromUsageRecord', () => {
  it('mints cost via priceUsageUsd (single pricing path)', () => {
    const t = telemetryFromUsageRecord('s1', 3, {
      bucket: 'premium',
      site: 'main',
      provider: 'anthropic',
      modelName: 'claude-opus-4-8',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(t.turn).toBe(3);
    expect(t.costUsd).toBe(priceUsageUsd('anthropic', 'claude-opus-4-8', 1_000_000, 1_000_000));
    expect(t.costUsd).toBe(15 + 75);
    expect(t.success).toBe(true);
  });

  it('includes cache-read/write cost (opus cache rates: 1.5 / 18.75 per M)', () => {
    const t = telemetryFromUsageRecord('s1', 1, {
      bucket: 'premium',
      site: 'main',
      provider: 'anthropic',
      modelName: 'claude-opus-4-8',
      promptTokens: 3100, // TOTAL prompt; the cache counts below are subsets
      completionTokens: 100,
      cacheReadTokens: 2000,
      cacheWriteTokens: 100,
    });
    // 3100 total - 2000 read - 100 write = 1000 at full input rate.
    // 1000*15 + 100*75 + 2000*1.5 + 100*18.75, all /1e6
    const expected = (1000 * 15 + 100 * 75 + 2000 * 1.5 + 100 * 18.75) / 1e6;
    expect(t.costUsd).toBeCloseTo(expected, 12);
  });

  it('records null cost for an uncatalogued model', () => {
    const t = telemetryFromUsageRecord('s1', 1, {
      bucket: 'pinned',
      site: 'specialist',
      provider: 'ollama',
      modelName: 'llama3.2',
      promptTokens: 100,
      completionTokens: 10,
    });
    expect(t.costUsd).toBeNull();
  });

  it('threads latency/success through, and captures callId/parentCallId from the dispatch context', () => {
    const build = () =>
      telemetryFromUsageRecord('s1', 1, {
        bucket: 'mid',
        site: 'pac-actor',
        provider: 'anthropic',
        modelName: 'claude-haiku-4-5-20251001',
        promptTokens: 10,
        completionTokens: 5,
        latencyMs: 1234,
        success: false,
      });
    // Inside a nested dispatch, the trace ids are captured from the ambient ALS.
    const inside = runWithDispatchId('root', () => runWithDispatchId('child', build));
    expect(inside).toMatchObject({
      latencyMs: 1234,
      success: false,
      callId: 'child',
      parentCallId: 'root',
    });
    // Off-loop (no active dispatch) → no ids.
    const outside = build();
    expect(outside.callId).toBeUndefined();
    expect(outside.parentCallId).toBeUndefined();
  });
});

describe('SessionTelemetry aggregation', () => {
  it('folds totals + by-layer/model/provider and counts calls across turns', () => {
    const s = store();
    s.beginTurn(); // turn 1
    s.record(
      rec({
        site: 'main',
        provider: 'anthropic',
        modelName: 'claude-opus-4-8',
        promptTokens: 1000,
        completionTokens: 100,
        costUsd: 1,
      }),
    );
    s.record(
      rec({
        site: 'main',
        provider: 'anthropic',
        modelName: 'claude-opus-4-8',
        promptTokens: 500,
        completionTokens: 40,
        costUsd: 0.5,
      }),
    );
    s.beginTurn(); // turn 2 — telemetry survives the turn boundary
    s.record(
      rec({
        site: 'tool-wrapper',
        bucket: 'mid',
        provider: 'anthropic',
        modelName: 'claude-haiku-4-5-20251001',
        promptTokens: 200,
        completionTokens: 20,
        costUsd: 0.02,
      }),
    );

    const sum = s.summary();
    expect(sum.totals.calls).toBe(3);
    expect(sum.totals.promptTokens).toBe(1700);
    expect(sum.totals.completionTokens).toBe(160);
    expect(sum.totals.costUsd).toBeCloseTo(1.52, 6);

    // By layer: two main calls fold into one row.
    expect(sum.byLayer.get('main')!.calls).toBe(2);
    expect(sum.byLayer.get('main')!.promptTokens).toBe(1500);
    expect(sum.byLayer.get('tool-wrapper')!.calls).toBe(1);

    // By model + provider.
    expect(sum.byModel.get('anthropic|claude-opus-4-8')!.completionTokens).toBe(140);
    expect(sum.byProvider.get('anthropic')!.calls).toBe(3);
  });

  it('keeps distinct sites as distinct byLayer rows', () => {
    const s = store();
    s.record(
      rec({
        site: 'rewriter',
        bucket: 'cheap',
        provider: 'anthropic',
        modelName: 'claude-haiku-4-5-20251001',
        promptTokens: 100,
        completionTokens: 5,
        costUsd: 0.01,
      }),
    );
    s.record(
      rec({
        site: 'recall-filter',
        bucket: 'cheap',
        provider: 'anthropic',
        modelName: 'claude-haiku-4-5-20251001',
        promptTokens: 50,
        completionTokens: 3,
        costUsd: 0.005,
      }),
    );
    const sum = s.summary();
    expect(sum.byLayer.get('rewriter')!.calls).toBe(1);
    expect(sum.byLayer.get('recall-filter')!.promptTokens).toBe(50);
    // But they fold together by model.
    expect(sum.byModel.get('anthropic|claude-haiku-4-5-20251001')!.calls).toBe(2);
  });

  it('surfaces a per-server mcp:<server> delegation site as its own BY LAYER row (#296/#299)', () => {
    const s = store();
    s.record(
      rec({
        site: 'main',
        provider: 'anthropic',
        modelName: 'claude-opus-4-8',
        promptTokens: 1000,
        completionTokens: 100,
        costUsd: 1,
      }),
    );
    s.record(
      rec({
        site: 'mcp:google',
        bucket: 'mid',
        provider: 'anthropic',
        modelName: 'claude-haiku-4-5-20251001',
        promptTokens: 300,
        completionTokens: 30,
        costUsd: 0.03,
      }),
    );
    const sum = s.summary();
    // The delegated helper's spend lands on its own layer, not folded into main.
    expect(sum.byLayer.get('mcp:google')!.calls).toBe(1);
    expect(sum.byLayer.get('mcp:google')!.promptTokens).toBe(300);
    expect(sum.byLayer.get('main')!.promptTokens).toBe(1000);
    // And it renders in the user-visible BY LAYER report.
    const lines = formatSessionUsageLines(sum).join('\n');
    expect(lines).toContain('mcp:google');
  });

  it('excludes null-cost calls from cost total but flags hasUnpriced', () => {
    const s = store();
    s.record(
      rec({
        site: 'main',
        provider: 'anthropic',
        modelName: 'claude-opus-4-8',
        promptTokens: 10,
        completionTokens: 1,
        costUsd: 2,
      }),
    );
    s.record(
      rec({
        site: 'specialist',
        provider: 'ollama',
        modelName: 'llama3.2',
        promptTokens: 999,
        completionTokens: 99,
        costUsd: null,
      }),
    );
    const sum = s.summary();
    expect(sum.totals.costUsd).toBe(2); // null-cost row contributes 0
    expect(sum.totals.hasUnpriced).toBe(true);
  });
});

describe('most expensive calls', () => {
  it('ranks by cost, then by tokens when cost ties/absent', () => {
    const s = store();
    s.record(rec({ site: 'a', provider: 'p', modelName: 'm', costUsd: 0.5, promptTokens: 10 }));
    s.record(rec({ site: 'b', provider: 'p', modelName: 'm', costUsd: 2.0, promptTokens: 10 }));
    s.record(rec({ site: 'c', provider: 'p', modelName: 'm', costUsd: null, promptTokens: 9999 }));
    const top = s.summary().mostExpensiveCalls;
    expect(top[0].site).toBe('b'); // highest cost
    expect(top[1].site).toBe('a');
    expect(top[2].site).toBe('c'); // unpriced ranks last despite huge tokens
  });

  it('falls back to token order when every call is unpriced', () => {
    const s = store();
    s.record(
      rec({
        site: 'small',
        provider: 'p',
        modelName: 'm',
        costUsd: null,
        promptTokens: 100,
        completionTokens: 10,
      }),
    );
    s.record(
      rec({
        site: 'big',
        provider: 'p',
        modelName: 'm',
        costUsd: null,
        promptTokens: 5000,
        completionTokens: 100,
      }),
    );
    expect(s.summary().mostExpensiveCalls[0].site).toBe('big');
  });
});

describe('trace tree', () => {
  it('nests child dispatches under their parent and roots off-loop calls', () => {
    const s = store();
    // Main dispatch (root, no parent).
    s.record(
      rec({
        site: 'main',
        provider: 'a',
        modelName: 'm',
        callId: 'main1',
        promptTokens: 100,
        costUsd: 1,
      }),
    );
    // Sub-agent nested under main.
    s.record(
      rec({
        site: 'pac-actor',
        provider: 'a',
        modelName: 'm',
        callId: 'sub1',
        parentCallId: 'main1',
        promptTokens: 50,
        costUsd: 0.5,
      }),
    );
    // Off-loop pre-turn call (no callId) → root.
    s.record(
      rec({ site: 'rewriter', provider: 'a', modelName: 'm', promptTokens: 10, costUsd: 0.01 }),
    );

    const tree = s.summary().tree;
    const main = tree.find((n) => n.callId === 'main1')!;
    expect(main).toBeDefined();
    expect(main.children.map((c) => c.callId)).toEqual(['sub1']);
    // rewriter is a root (off-loop), not a child of main.
    expect(tree.some((n) => n.site === 'rewriter' && n.callId === null)).toBe(true);
  });

  it('roots a child whose parent produced no telemetry node', () => {
    const s = store();
    s.record(
      rec({
        site: 'sub',
        provider: 'a',
        modelName: 'm',
        callId: 'sub9',
        parentCallId: 'ghost',
        promptTokens: 5,
      }),
    );
    const tree = s.summary().tree;
    expect(tree).toHaveLength(1);
    expect(tree[0].callId).toBe('sub9');
  });
});

describe('persistence', () => {
  it('does not throw when the filesystem write fails; aggregate still folds', () => {
    // A log path whose parent is a *file* → recursive mkdir throws ENOTDIR
    // reliably (independent of the runner's uid), exercising the fail-open catch.
    const blocker = path.join(os.tmpdir(), `bernard-telem-blocker-${process.pid}`);
    fs.writeFileSync(blocker, 'x');
    try {
      const s = new SessionTelemetry('sfail', {
        persist: true,
        logPath: path.join(blocker, 'nested', 'x.jsonl'),
      });
      expect(() =>
        s.record(
          rec({ site: 'main', provider: 'a', modelName: 'm', promptTokens: 10, costUsd: 1 }),
        ),
      ).not.toThrow();
      expect(s.summary().totals.calls).toBe(1);
    } finally {
      fs.rmSync(blocker, { force: true });
    }
  });

  it('writes a JSONL line per record when persisting, and nothing when disabled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-telem-'));
    const logPath = path.join(dir, 's.jsonl');
    try {
      const on = new SessionTelemetry('son', { persist: true, logPath });
      on.record(rec({ site: 'main', provider: 'a', modelName: 'm', promptTokens: 1, costUsd: 1 }));
      on.record(
        rec({ site: 'rewriter', provider: 'a', modelName: 'm', promptTokens: 2, costUsd: 2 }),
      );
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).site).toBe('main');

      const offPath = path.join(dir, 'off.jsonl');
      const off = new SessionTelemetry('soff', { persist: false, logPath: offPath });
      off.record(rec({ site: 'main', provider: 'a', modelName: 'm', promptTokens: 1 }));
      expect(fs.existsSync(offPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('telemetryEnabled', () => {
  it('is on by default and off only for explicit false/0', () => {
    const orig = process.env.BERNARD_TELEMETRY;
    try {
      delete process.env.BERNARD_TELEMETRY;
      expect(telemetryEnabled()).toBe(true);
      process.env.BERNARD_TELEMETRY = 'false';
      expect(telemetryEnabled()).toBe(false);
      process.env.BERNARD_TELEMETRY = '0';
      expect(telemetryEnabled()).toBe(false);
      process.env.BERNARD_TELEMETRY = 'true';
      expect(telemetryEnabled()).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.BERNARD_TELEMETRY;
      else process.env.BERNARD_TELEMETRY = orig;
    }
  });
});

describe('aggregateRecords + formatSessionUsageLines', () => {
  it('rebuilds an aggregate from flat records and renders a report', () => {
    const records: Rec[] = [
      rec({
        site: 'main',
        provider: 'anthropic',
        modelName: 'claude-opus-4-8',
        callId: 'm1',
        promptTokens: 1000,
        completionTokens: 100,
        costUsd: 1.2,
        latencyMs: 900,
      }),
      rec({
        site: 'pac-actor',
        bucket: 'mid',
        provider: 'anthropic',
        modelName: 'claude-haiku-4-5-20251001',
        callId: 's1',
        parentCallId: 'm1',
        promptTokens: 300,
        completionTokens: 30,
        costUsd: 0.03,
      }),
    ];
    const sum = aggregateRecords('sX', records);
    expect(sum.totals.calls).toBe(2);
    expect(sum.totals.costUsd).toBeCloseTo(1.23, 6);

    // Duration comes from the record timestamps (span), not `Date.now() -
    // startedAt` — a session reconstructed from disk must not render "0s".
    const early = { ...records[0], ts: '2026-08-07T00:00:00.000Z' };
    const late = { ...records[1], ts: '2026-08-07T00:05:00.000Z' };
    const spanned = aggregateRecords('sSpan', [early, late]);
    expect(spanned.durationMs).toBe(5 * 60 * 1000);
    expect(spanned.startedAt).toBe(Date.parse('2026-08-07T00:00:00.000Z'));

    const lines = formatSessionUsageLines(sum).join('\n');
    expect(lines).toContain('Bernard session: sX');
    expect(lines).toContain('BY LAYER');
    expect(lines).toContain('main');
    expect(lines).toContain('pac-actor');
    expect(lines).toContain('TRACE');
    // The tree indents the child under its parent.
    expect(lines).toMatch(/main.*\n.*pac-actor/s);
  });
});

describe('legacy-derived totals are marked an upper bound (#388)', () => {
  const catalogued = { site: 'main', provider: 'anthropic', modelName: 'claude-opus-4-8' } as const;

  /** A record priced under the current generation — not legacy. */
  function modern(promptTokens: number) {
    return rec({
      ...catalogued,
      promptTokens,
      completionTokens: 10,
      costUsd: null,
      pricingVersion: PRICING_VERSION,
    });
  }
  /** A record from before cache-aware capture — its cost may be overstated. */
  function legacy(promptTokens: number) {
    return rec({ ...catalogued, promptTokens, completionTokens: 10, costUsd: null });
  }

  it('accumulates the legacy share of cost, not just the call count', () => {
    const sum = aggregateRecords('sShare', [legacy(1000), modern(1000)]);
    expect(sum.legacyPricedCalls).toBe(1);
    // Same tokens either side, so the legacy half is half the money.
    expect(sum.legacyPricedCostUsd).toBeCloseTo(sum.totals.costUsd / 2, 9);
  });

  it('marks the headline when most of the money is legacy-derived', () => {
    const lines = formatSessionUsageLines(aggregateRecords('sAll', [legacy(1000), legacy(2000)]));
    expect(lines[1]).toContain('(upper bound)');
  });

  it('does NOT mark a total that is only incidentally legacy', () => {
    // The reason the threshold is a share of COST and not of calls: many cheap
    // legacy calls beside a few expensive modern ones is a total that is
    // essentially right, and a caveat that fires there becomes noise.
    const many = Array.from({ length: 20 }, () => legacy(1));
    const lines = formatSessionUsageLines(aggregateRecords('sMixed', [...many, modern(500_000)]));
    expect(lines[1]).not.toContain('(upper bound)');
  });

  it('leaves the TOTAL block unqualified — its full caveat follows it', () => {
    const lines = formatSessionUsageLines(aggregateRecords('sAll2', [legacy(1000)]));
    const totalCost = lines.find((l) => l.trimStart().startsWith('Cost:'));
    expect(totalCost).toBeDefined();
    expect(totalCost).not.toContain('(upper bound)');
    expect(lines.some((l) => l.includes('predates cache-aware token capture'))).toBe(true);
  });

  it('says nothing for a fully current session', () => {
    const lines = formatSessionUsageLines(aggregateRecords('sModern', [modern(1000)]));
    expect(lines[1]).not.toContain('(upper bound)');
  });
});

describe('re-pricing on read (#309)', () => {
  // A real catalogued model, so `priceUsageUsd` returns a number here.
  const catalogued = { site: 'main', provider: 'anthropic', modelName: 'claude-opus-4-8' } as const;

  it('recovers cost for a record stored unpriced', () => {
    const expected = priceUsageUsd('anthropic', 'claude-opus-4-8', 1000, 100, {});
    expect(expected).not.toBeNull();

    const sum = aggregateRecords('sRep', [
      rec({ ...catalogued, promptTokens: 1000, completionTokens: 100, costUsd: null }),
    ]);
    expect(sum.totals.costUsd).toBeCloseTo(expected as number, 9);
    expect(sum.totals.hasUnpriced).toBe(false);
    expect(sum.repricedCalls).toBe(1);
  });

  it('never overwrites a cost that was already minted', () => {
    // Re-pricing runs today's catalog against yesterday's call. A stored number
    // is the price as it was believed at the time; only `null` carries no
    // information. This is the guarantee that makes the fix safe to apply to
    // every historical session.
    const sum = aggregateRecords('sKeep', [
      rec({ ...catalogued, promptTokens: 1000, completionTokens: 100, costUsd: 0.01 }),
    ]);
    expect(sum.totals.costUsd).toBeCloseTo(0.01, 9);
    expect(sum.repricedCalls).toBe(0);
  });

  it('leaves an uncatalogued record unpriced rather than inventing a number', () => {
    const sum = aggregateRecords('sUnk', [
      rec({
        site: 'main',
        provider: 'someco',
        modelName: 'mystery-1',
        promptTokens: 1000,
        costUsd: null,
      }),
    ]);
    expect(sum.totals.hasUnpriced).toBe(true);
    expect(sum.repricedCalls).toBe(0);
  });

  it('counts records minted before cache-aware pricing as possibly overstated', () => {
    const sum = aggregateRecords('sLegacy', [
      // No `pricingVersion` — written by a build that billed cached input at the
      // full rate and recorded `cacheReadTokens: 0`, so the overstatement is
      // unrecoverable from the record.
      rec({ ...catalogued, promptTokens: 1000, costUsd: 2.79 }),
      rec({ ...catalogued, promptTokens: 1000, costUsd: 0.9, pricingVersion: PRICING_VERSION }),
    ]);
    expect(sum.legacyPricedCalls).toBe(1);
  });

  it('still flags a re-priced pre-v2 record as possibly overstated', () => {
    // The two populations overlap: the sessions recorded while xAI was missing
    // from the catalog ALSO predate cache-token capture. Re-pricing recovers a
    // number from their token counts, but those counts record `cacheReadTokens:
    // 0` regardless of what was actually cached — so the recovered figure bills
    // every input token at the full rate and is an upper bound, not a fact.
    // Stamping the copy as current-generation would hide exactly that.
    const sum = aggregateRecords('sBoth', [
      rec({ ...catalogued, promptTokens: 1000, completionTokens: 100, costUsd: null }),
    ]);
    expect(sum.repricedCalls).toBe(1);
    expect(sum.legacyPricedCalls).toBe(1);
  });

  it('does not flag a re-priced record whose source was already current-generation', () => {
    const sum = aggregateRecords('sModern', [
      rec({
        ...catalogued,
        promptTokens: 1000,
        completionTokens: 100,
        costUsd: null,
        pricingVersion: PRICING_VERSION,
      }),
    ]);
    expect(sum.repricedCalls).toBe(1);
    expect(sum.legacyPricedCalls).toBe(0);
  });

  it('reports both caveats in the rendered usage lines', () => {
    const sum = aggregateRecords('sLines', [
      rec({ ...catalogued, promptTokens: 1000, completionTokens: 100, costUsd: null }),
      rec({ ...catalogued, promptTokens: 1000, costUsd: 2.79 }),
    ]);
    const lines = formatSessionUsageLines(sum).join('\n');
    expect(lines).toContain('re-priced from the current catalog');
    expect(lines).toContain('may be overstated');
  });

  it('reports neither caveat for a session priced entirely under the current generation', () => {
    const sum = aggregateRecords('sClean', [
      rec({ ...catalogued, promptTokens: 1000, costUsd: 0.9, pricingVersion: PRICING_VERSION }),
    ]);
    const lines = formatSessionUsageLines(sum).join('\n');
    expect(lines).not.toContain('re-priced');
    expect(lines).not.toContain('overstated');
  });

  it('stamps the current pricing version on newly minted records', () => {
    const t = telemetryFromUsageRecord('s1', 1, {
      bucket: 'premium',
      site: 'main',
      provider: 'anthropic',
      modelName: 'claude-opus-4-8',
      promptTokens: 10,
      completionTokens: 1,
    });
    expect(t.pricingVersion).toBe(PRICING_VERSION);
  });
});

describe('tier tracking per aggregate row', () => {
  it('records every tier a layer ran at, not just the first', () => {
    // `main` is not pinned to one tier: the policy resolves premium on a turn's
    // first step and mid on continuations. A scalar would report only one.
    const st = store();
    st.record(rec({ site: 'main', provider: 'xai', modelName: 'grok-4.5', bucket: 'premium' }));
    st.record(rec({ site: 'main', provider: 'xai', modelName: 'grok-4.5', bucket: 'mid' }));
    st.record(rec({ site: 'rewriter', provider: 'xai', modelName: 'grok-4.3', bucket: 'cheap' }));

    const s = st.summary();
    expect(s.byLayer.get('main')?.tiers).toEqual(new Set(['premium', 'mid']));
    expect(s.byLayer.get('rewriter')?.tiers).toEqual(new Set(['cheap']));
  });

  it('surfaces one model serving two tiers — the tiering is buying nothing', () => {
    // The xAI lineup binds orchestrator premium AND mid to grok-4.5, so
    // `balanced` mode never actually downshifts the main agent.
    const st = store();
    st.record(rec({ site: 'main', provider: 'xai', modelName: 'grok-4.5', bucket: 'premium' }));
    st.record(rec({ site: 'main', provider: 'xai', modelName: 'grok-4.5', bucket: 'mid' }));

    expect(st.summary().byModel.get('xai|grok-4.5')?.tiers).toEqual(new Set(['premium', 'mid']));
  });

  it('collects membership regardless of arrival order (display order is formatTiers)', () => {
    const st = store();
    st.record(rec({ site: 'main', provider: 'xai', modelName: 'm', bucket: 'cheap' }));
    st.record(rec({ site: 'main', provider: 'xai', modelName: 'm', bucket: 'premium' }));
    st.record(rec({ site: 'main', provider: 'xai', modelName: 'm', bucket: 'mid' }));
    st.record(rec({ site: 'main', provider: 'xai', modelName: 'm', bucket: 'mid' }));

    expect(st.summary().byLayer.get('main')?.tiers).toEqual(new Set(['premium', 'mid', 'cheap']));
  });

  it('snapshots the tier set by value so later records cannot mutate it', () => {
    const st = store();
    st.record(rec({ site: 'main', provider: 'xai', modelName: 'm', bucket: 'premium' }));
    const before = st.summary().byLayer.get('main')!.tiers;
    st.record(rec({ site: 'main', provider: 'xai', modelName: 'm', bucket: 'cheap' }));
    expect(before).toEqual(new Set(['premium']));
  });

  it('renders the tier column in BY LAYER but leaves BY PROVIDER blank', () => {
    const st = store();
    st.record(rec({ site: 'main', provider: 'xai', modelName: 'grok-4.5', bucket: 'premium' }));
    st.record(rec({ site: 'main', provider: 'xai', modelName: 'grok-4.5', bucket: 'mid' }));
    const text = formatSessionUsageLines(st.summary()).join('\n');

    expect(text).toMatch(/BY LAYER[\s\S]*?main\s+premium\+mid/);
    // A provider spans every tier by construction — noise, and it overflowed
    // the column when rendered.
    expect(text).toMatch(/BY PROVIDER[\s\S]*?xai\s+\d/);
  });
});
