import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  roleForSite,
  aggregateRecords,
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
    role: 'orchestrator',
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

describe('roleForSite', () => {
  it('maps known ModelSites, PAC phases, and falls back to unknown', () => {
    expect(roleForSite('main')).toBe('orchestrator');
    expect(roleForSite('rewriter')).toBe('classifier');
    expect(roleForSite('recall-filter')).toBe('classifier');
    expect(roleForSite('tool-wrapper')).toBe('function-caller');
    expect(roleForSite('pac-planner')).toBe('executor');
    expect(roleForSite('pac-critic')).toBe('executor');
    expect(roleForSite('cron')).toBe('orchestrator');
    expect(roleForSite('totally-unknown')).toBe('unknown');
  });
});

describe('telemetryFromUsageRecord', () => {
  it('mints cost via priceUsageUsd (single pricing path) and derives role', () => {
    const t = telemetryFromUsageRecord('s1', 3, {
      bucket: 'premium',
      site: 'main',
      provider: 'anthropic',
      modelName: 'claude-opus-4-8',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(t.turn).toBe(3);
    expect(t.role).toBe('orchestrator');
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
      promptTokens: 1000, // uncached input (disjoint from cache)
      completionTokens: 100,
      cacheReadTokens: 2000,
      cacheWriteTokens: 100,
    });
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

  it('threads latency/success/callId/parentCallId through', () => {
    const t = telemetryFromUsageRecord('s1', 1, {
      bucket: 'mid',
      site: 'pac-actor',
      provider: 'anthropic',
      modelName: 'claude-haiku-4-5-20251001',
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 1234,
      success: false,
      callId: 'child',
      parentCallId: 'root',
    });
    expect(t).toMatchObject({
      latencyMs: 1234,
      success: false,
      callId: 'child',
      parentCallId: 'root',
    });
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
        role: 'function-caller',
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

  it('collapses sites sharing a role in byRole', () => {
    const s = store();
    s.record(
      rec({
        site: 'rewriter',
        role: 'classifier',
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
        role: 'classifier',
        bucket: 'cheap',
        provider: 'anthropic',
        modelName: 'claude-haiku-4-5-20251001',
        promptTokens: 50,
        completionTokens: 3,
        costUsd: 0.005,
      }),
    );
    const sum = s.summary();
    expect(sum.byRole.get('classifier')!.calls).toBe(2);
    expect(sum.byRole.get('classifier')!.promptTokens).toBe(150);
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

  it('sums latency into latencyMsTotal', () => {
    const s = store();
    s.record(
      rec({ site: 'main', provider: 'anthropic', modelName: 'claude-opus-4-8', latencyMs: 100 }),
    );
    s.record(
      rec({ site: 'main', provider: 'anthropic', modelName: 'claude-opus-4-8', latencyMs: 250 }),
    );
    expect(s.summary().totals.latencyMsTotal).toBe(350);
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
        role: 'executor',
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
