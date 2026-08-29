/**
 * @module session-telemetry
 *
 * Durable, session-level, layer-attributed LLM cost/usage telemetry.
 *
 * Bernard already accounts every LLM token per turn (issues #258/#269): every
 * token-producing call folds into {@link module:framework/hooks/token-stats}'s
 * `recordTurnUsage`, which is cleared at each turn boundary. This module hangs a
 * cross-turn sink off that single convergence point so the whole session's spend
 * survives turn resets, is broken down by layer/model/provider, and is persisted
 * to a per-session JSONL for later inspection — without duplicating pricing
 * (reuses {@link priceUsageForRecord}) or the site/layer vocabulary.
 *
 * **Privacy**: records carry only numbers, ids, and labels — never prompt or
 * response text, tool args, or results. **Fail-open**: a fold or persist error
 * can never propagate into a model call.
 */
import type { UsageBucket } from './output.js';
import type { UsageRecord } from './framework/hooks/token-stats.js';
import { getCurrentDispatchIds } from './framework/dispatch-context.js';
import { truncate } from './text.js';
import {
  priceUsageForRecord,
  formatAggCost,
  formatCallCost,
  formatTiers,
  costUpperBoundSuffix,
} from './usage-report.js';
import { formatTokenCount, formatElapsed } from './output.js';
import { appendJsonl, readJsonlTail, listFilesByMtime, pruneFilesByMtime } from './jsonl.js';
import { TELEMETRY_DIR, sessionTelemetryPath } from './paths.js';
import { plural } from './text.js';

/**
 * One normalized model-call telemetry record (≈ one billed AI-SDK step). No
 * prompt/response content — tokens/cost/latency/ids/labels only. The `site`
 * label is the layer; role (if ever needed) is derivable from it via
 * `SITE_ROLE` at analysis time.
 */
export interface ModelCallTelemetry {
  ts: string;
  sessionId: string;
  /** The dispatch this step ran in; absent for off-loop calls (trace root). */
  callId?: string;
  /** The enclosing dispatch (tree edge); absent at the top level / off-loop. */
  parentCallId?: string;
  /** Per-session turn counter, for grouping records by turn. */
  turn: number;
  bucket: UsageBucket;
  /** Logical layer (`main`, `rewriter`, `pac-planner`, `tool-wrapper`, …). */
  site: string;
  provider: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated USD (catalog pricing), or `null` when the model is uncatalogued. */
  costUsd: number | null;
  /**
   * Which pricing generation minted `costUsd`. Absent on records written before
   * {@link PRICING_VERSION} existed — those predate the cache-token fix and can
   * overstate cost by up to ~3x, which is *not* recoverable from the record
   * (they carry `cacheReadTokens: 0` because the field was never read). Reports
   * label such sessions rather than presenting the figure as authoritative
   * (#309).
   */
  pricingVersion?: number;
  latencyMs?: number;
  success: boolean;
}

/**
 * Pricing-generation stamp for newly minted records.
 *
 * v2 = cache-aware pricing: cached input is billed at the provider's cache-read
 * rate instead of the full input rate. Records without this field were minted
 * by a build that charged cached input at full price *and* recorded
 * `cacheReadTokens: 0`, so their overstatement cannot be undone after the fact.
 * Bump this whenever a change makes previously-minted costs wrong.
 *
 * Stamped per record rather than once per file: `readSessionTelemetry` uses
 * `readJsonlTail(file, limit)`, and a tail read never sees a header — so a
 * file-level stamp would be invisible to the only reader there is.
 */
export const PRICING_VERSION = 2;

/** A rolled-up bucket of spend, keyed by layer / model / provider. */
export interface TelemetryAgg {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  /** Sum of priced records; unpriced records contribute 0. */
  costUsd: number;
  /** True when at least one folded record had no catalog pricing. */
  hasUnpriced: boolean;
  /**
   * Every cost tier folded into this row. A layer is not pinned to one tier —
   * `main` runs premium on the first step of a turn and mid on continuations —
   * so this is a set, not a scalar. Surfacing it is what makes "premium and mid
   * resolve to the same model" visible in the breakdown instead of only in the
   * per-turn tier table. Unordered on purpose: `formatTiers` is the single owner
   * of display order.
   */
  tiers: Set<UsageBucket>;
}

/** One node of the hierarchical dispatch trace (a rolled-up dispatch). */
export interface TelemetryTreeNode extends TelemetryAgg {
  /** Dispatch id, or `null` for the off-loop grouping node. */
  callId: string | null;
  parentCallId: string | null;
  /** Representative layer for the node (first record seen for this dispatch). */
  site: string;
  provider: string;
  modelName: string;
  children: TelemetryTreeNode[];
}

/** A full snapshot of the session's spend, for the viewer / CLI. */
export interface TelemetryAggregate {
  sessionId: string;
  startedAt: number;
  durationMs: number;
  totals: TelemetryAgg;
  byLayer: Map<string, TelemetryAgg>;
  byModel: Map<string, TelemetryAgg>;
  byProvider: Map<string, TelemetryAgg>;
  /** Costliest calls (by cost, then tokens), most-expensive first. */
  mostExpensiveCalls: ModelCallTelemetry[];
  /** Root nodes of the dispatch trace tree. */
  tree: TelemetryTreeNode[];
  /**
   * Records whose `costUsd` was `null` on disk and was recovered at read time
   * from the current catalog (#309). Always 0 for a live session.
   */
  repricedCalls: number;
  /**
   * Records minted before {@link PRICING_VERSION} — their stored cost may
   * overstate actual spend and cannot be corrected from what was recorded.
   * Always 0 for a live session.
   */
  legacyPricedCalls: number;
  /**
   * Portion of {@link TelemetryAgg.costUsd} contributed by those legacy
   * records. The count alone is the wrong discriminator for "is this figure
   * trustworthy" — many cheap legacy calls beside a few expensive modern ones
   * barely move the total. Always 0 for a live session.
   */
  legacyPricedCostUsd: number;
}

/** How many top calls to retain — matches what the viewer + CLI display. */
const TOP_CALLS = 5;

/**
 * Cap on retained per-session telemetry files (mirrors the debug session-log
 * `MAX_SESSION_FILES`). Without this, one JSONL accumulates per session forever.
 */
const MAX_TELEMETRY_FILES = 50;
/** Prune runs once per process, on the first persisting sink's construction. */
let telemetryPruned = false;

/** True unless `BERNARD_TELEMETRY` is explicitly `false`/`0`. */
export function telemetryEnabled(): boolean {
  const v = process.env.BERNARD_TELEMETRY;
  return v !== 'false' && v !== '0';
}

/**
 * Build a normalized {@link ModelCallTelemetry} from a {@link UsageRecord} — the
 * single place cost is minted (via {@link priceUsageForRecord}) so there's no second
 * pricing path, and the single place the dispatch-trace ids are captured (from
 * the ambient dispatch context: real ids inside a dispatch, `undefined` for
 * off-loop calls — the correct value). `ts` is stamped at call time.
 *
 * **Contract:** call this synchronously in the context that produced `rec` (the
 * dispatch's async scope, or genuinely off-loop). The trace ids come from ambient
 * `AsyncLocalStorage`, not the arguments — buffering `rec` and pricing it later,
 * after the dispatch scope has exited, would silently capture the wrong `callId`.
 */
export function telemetryFromUsageRecord(
  sessionId: string,
  turn: number,
  rec: UsageRecord,
): ModelCallTelemetry {
  const { dispatchId, parentDispatchId } = getCurrentDispatchIds();
  return {
    ts: new Date().toISOString(),
    sessionId,
    callId: dispatchId,
    parentCallId: parentDispatchId,
    turn,
    bucket: rec.bucket,
    site: rec.site,
    provider: rec.provider,
    modelName: rec.modelName,
    promptTokens: rec.promptTokens,
    completionTokens: rec.completionTokens,
    cacheReadTokens: rec.cacheReadTokens ?? 0,
    cacheWriteTokens: rec.cacheWriteTokens ?? 0,
    costUsd: priceUsageForRecord(rec),
    pricingVersion: PRICING_VERSION,
    latencyMs: rec.latencyMs,
    success: rec.success ?? true,
  };
}

function emptyAgg(): TelemetryAgg {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    calls: 0,
    costUsd: 0,
    hasUnpriced: false,
    tiers: new Set(),
  };
}

function foldInto(agg: TelemetryAgg, e: ModelCallTelemetry): void {
  agg.promptTokens += e.promptTokens;
  agg.completionTokens += e.completionTokens;
  agg.cacheReadTokens += e.cacheReadTokens;
  agg.cacheWriteTokens += e.cacheWriteTokens;
  agg.calls += 1;
  if (e.costUsd == null) agg.hasUnpriced = true;
  else agg.costUsd += e.costUsd;
  agg.tiers.add(e.bucket);
}

function upsert(map: Map<string, TelemetryAgg>, key: string, e: ModelCallTelemetry): void {
  let agg = map.get(key);
  if (!agg) {
    agg = emptyAgg();
    map.set(key, agg);
  }
  foldInto(agg, e);
}

/** Sort key so priced calls rank above unpriced (null → below all), then by tokens. */
function costRank(e: ModelCallTelemetry): number {
  return e.costUsd ?? -1;
}
function tokenTotal(e: ModelCallTelemetry): number {
  return e.promptTokens + e.completionTokens;
}

/** Aggregate map entries sorted costliest-first (then by prompt tokens). */
export function sortedAggEntries(map: Map<string, TelemetryAgg>): [string, TelemetryAgg][] {
  return Array.from(map.entries()).sort(
    (a, b) => b[1].costUsd - a[1].costUsd || b[1].promptTokens - a[1].promptTokens,
  );
}

/**
 * Cross-turn telemetry store for one Bernard session. Constructed once at REPL
 * start (rides `SpinnerStats`, so it survives per-turn ledger resets). Every
 * `record` folds the in-memory aggregate and best-effort appends a JSONL line.
 */
export class SessionTelemetry {
  readonly sessionId: string;
  readonly startedAt: number;
  private turnCounter = 0;
  private readonly persist: boolean;
  private readonly logPath: string;

  private readonly totals = emptyAgg();
  private readonly byLayer = new Map<string, TelemetryAgg>();
  private readonly byModel = new Map<string, TelemetryAgg>();
  private readonly byProvider = new Map<string, TelemetryAgg>();
  private topCalls: ModelCallTelemetry[] = [];
  // Per-dispatch accumulator nodes, keyed by callId (or `off:<site>` for
  // off-loop, no-callId records). `children` stays empty here — the tree edges
  // are wired on fresh copies in `buildTree` so `summary()` is idempotent.
  private readonly nodes = new Map<string, TelemetryTreeNode>();

  constructor(sessionId: string, opts?: { persist?: boolean; logPath?: string }) {
    this.sessionId = sessionId;
    this.startedAt = Date.now();
    this.persist = opts?.persist ?? telemetryEnabled();
    this.logPath = opts?.logPath ?? sessionTelemetryPath(sessionId);
    // Retain only the N most-recent session files (this session's file doesn't
    // exist yet, so it's never pruned). Once per process, best-effort.
    if (this.persist && !telemetryPruned) {
      telemetryPruned = true;
      pruneFilesByMtime(TELEMETRY_DIR, MAX_TELEMETRY_FILES, '.jsonl');
    }
  }

  /** Current per-session turn counter (0 before the first turn opens). */
  get turn(): number {
    return this.turnCounter;
  }

  /** Open a new turn — bumps the counter records are stamped with. */
  beginTurn(): void {
    this.turnCounter += 1;
  }

  /** Fold one record into the aggregate + best-effort persist. Never throws. */
  record(entry: ModelCallTelemetry): void {
    try {
      this.fold(entry);
    } catch {
      // aggregate math must never break a model call
    }
    // `appendJsonl` is itself fail-open (lazy-mkdirs + swallows I/O errors).
    if (this.persist) appendJsonl(this.logPath, entry);
  }

  /**
   * Mint a telemetry record from a {@link UsageRecord} (stamping this session's
   * id + turn) and record it. The one place that "record a usage observation"
   * lives, so callers don't re-thread `sessionId`/`turn` back into the builder.
   */
  recordUsage(rec: UsageRecord): void {
    this.record(telemetryFromUsageRecord(this.sessionId, this.turn, rec));
  }

  private fold(e: ModelCallTelemetry): void {
    foldInto(this.totals, e);
    upsert(this.byLayer, e.site, e);
    upsert(this.byModel, `${e.provider}|${e.modelName}`, e);
    upsert(this.byProvider, e.provider, e);
    this.foldNode(e);
    this.foldTopCall(e);
  }

  private foldNode(e: ModelCallTelemetry): void {
    const key = e.callId ?? `off:${e.site}`;
    let node = this.nodes.get(key);
    if (!node) {
      node = {
        ...emptyAgg(),
        callId: e.callId ?? null,
        parentCallId: e.parentCallId ?? null,
        site: e.site,
        provider: e.provider,
        modelName: e.modelName,
        children: [],
      };
      this.nodes.set(key, node);
    }
    foldInto(node, e);
  }

  private foldTopCall(e: ModelCallTelemetry): void {
    this.topCalls.push(e);
    this.topCalls.sort((a, b) => costRank(b) - costRank(a) || tokenTotal(b) - tokenTotal(a));
    if (this.topCalls.length > TOP_CALLS) this.topCalls.length = TOP_CALLS;
  }

  /**
   * O(1) reads of the running totals, for callers that need one number and not
   * a snapshot. {@link summary} clones three maps and rebuilds the dispatch
   * tree, so reaching through it for a scalar is quadratic in session length.
   */
  get calls(): number {
    return this.totals.calls;
  }

  /** Whether any folded call was unpriced — see `SpinnerStats.sessionCostPartial`. */
  get hasUnpriced(): boolean {
    return this.totals.hasUnpriced;
  }

  /** Pure snapshot for the `/usage` viewer + `bernard usage` CLI. */
  summary(): TelemetryAggregate {
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      durationMs: Date.now() - this.startedAt,
      totals: { ...this.totals, tiers: new Set(this.totals.tiers) },
      byLayer: cloneAggMap(this.byLayer),
      byModel: cloneAggMap(this.byModel),
      byProvider: cloneAggMap(this.byProvider),
      mostExpensiveCalls: this.topCalls.slice(),
      tree: buildTreeFromNodes(Array.from(this.nodes.values())),
      // A live session prices every call once, at mint time — there is nothing
      // to recover and no older generation in play. `aggregateRecords` fills
      // these in for a session replayed from disk.
      repricedCalls: 0,
      legacyPricedCalls: 0,
      legacyPricedCostUsd: 0,
    };
  }
}

function cloneAggMap(map: Map<string, TelemetryAgg>): Map<string, TelemetryAgg> {
  const out = new Map<string, TelemetryAgg>();
  for (const [k, v] of map) out.set(k, { ...v, tiers: new Set(v.tiers) });
  return out;
}

/**
 * Reconstruct the dispatch tree from flat accumulator nodes. A node attaches
 * under its parent when that parent dispatch is itself a node (it always is when
 * the parent produced ≥1 telemetry record — e.g. the main agent's own steps);
 * otherwise it becomes a root. Off-loop nodes (`callId: null`) are always roots.
 * Operates on fresh copies so it never mutates the stored accumulators.
 */
function buildTreeFromNodes(accs: TelemetryTreeNode[]): TelemetryTreeNode[] {
  const nodes = accs.map((a) => ({ ...a, children: [] as TelemetryTreeNode[] }));
  const byCall = new Map<string, TelemetryTreeNode>();
  for (const n of nodes) {
    if (n.callId) byCall.set(n.callId, n);
  }
  const roots: TelemetryTreeNode[] = [];
  for (const n of nodes) {
    const parent = n.parentCallId ? byCall.get(n.parentCallId) : undefined;
    if (parent && parent !== n) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}

/**
 * Read a session's persisted telemetry (most-recent `limit` records). When
 * `sessionId` is omitted, resolves the newest telemetry file by mtime. Never
 * throws — returns `[]` on any error / missing file.
 */
export function readSessionTelemetry(sessionId?: string, limit?: number): ModelCallTelemetry[] {
  const file = sessionId ? sessionTelemetryPath(sessionId) : latestTelemetryFile();
  if (!file) return [];
  return readJsonlTail<ModelCallTelemetry>(file, limit);
}

/** Session ids that have a persisted telemetry file, newest (by mtime) first. */
export function listTelemetrySessions(): string[] {
  return listFilesByMtime(TELEMETRY_DIR, '.jsonl').map((f) => f.name.replace(/\.jsonl$/, ''));
}

function latestTelemetryFile(): string | null {
  const [id] = listTelemetrySessions();
  return id ? sessionTelemetryPath(id) : null;
}

/**
 * Recover the cost of a record that was stored unpriced (#309).
 *
 * Cost is minted once, at record time, from the catalog as it stood that day —
 * so a model missing from the catalog freezes as `costUsd: null` and renders
 * `n/a` forever, even after the catalog is fixed. That is exactly what happened
 * when the gateway's owner rename dropped every xAI model: 311 records across
 * two sessions, ~$7 of real spend, reported as `$0`.
 *
 * **Fills nulls only, never overwrites.** Re-pricing runs today's catalog
 * against yesterday's call, so blanket re-pricing would silently rewrite
 * history whenever a vendor changes prices. A stored number is the price as it
 * was believed at the time and is left alone; `null` carries no information, so
 * replacing it can only improve on `n/a`.
 *
 * Returns the record unchanged when it is already priced or still uncatalogued
 * (e.g. a custom provider — `getModelMeta` returns `null` for anything outside
 * `BUILTIN_PROVIDERS`, so those stay unpriced by construction).
 */
function repriceIfUnpriced(
  rec: ModelCallTelemetry,
  priceOf: (rec: ModelCallTelemetry) => number | null,
): ModelCallTelemetry {
  if (rec.costUsd != null) return rec;
  const costUsd = priceOf(rec);
  // Deliberately does NOT stamp `pricingVersion`. Today's pricing logic ran,
  // but over token counts captured before cache accounting existed — a record
  // written by such a build carries `cacheReadTokens: 0` whether or not any
  // input was actually served from cache, so the recovered figure inherits the
  // same overstatement as a stored one. Leaving the field absent keeps that
  // visible instead of laundering it into a confident number.
  return costUsd == null ? rec : { ...rec, costUsd };
}

/**
 * Fold a flat list of records into a full aggregate (same shape as
 * {@link SessionTelemetry.summary}). Used by the CLI to summarize a persisted
 * session without a live store.
 *
 * Records are re-priced on read (see {@link repriceIfUnpriced}) rather than
 * rewritten on disk: the JSONL stays an append-only log of what was believed at
 * the time, and a later catalog fix improves every report without a migration.
 */
export function aggregateRecords(
  sessionId: string,
  records: ModelCallTelemetry[],
): TelemetryAggregate {
  const store = new SessionTelemetry(sessionId, { persist: false });
  // Remember which models the catalog cannot price, keyed on (provider, model)
  // — the token counts differ per record, so the *price* is not cacheable, but
  // the catalog lookup behind it is. `getModelMeta` scans the catalog, and a
  // miss scans it a second time normalizing every id. That miss path is exactly
  // the case this function exists for: a session where every record is unpriced
  // because the provider is still absent. A session has 3-6 distinct models
  // against hundreds of records, so one lookup per model replaces one per row.
  const unpriceable = new Set<string>();
  const priceOf = (rec: ModelCallTelemetry): number | null => {
    const key = `${rec.provider}|${rec.modelName}`;
    if (unpriceable.has(key)) return null;
    const cost = priceUsageForRecord(rec);
    if (cost === null) unpriceable.add(key);
    return cost;
  };
  let repricedCalls = 0;
  let legacyPricedCalls = 0;
  let legacyPricedCostUsd = 0;
  // `persist: false` makes `record` a pure in-memory fold (no disk write).
  for (const r of records) {
    const priced = repriceIfUnpriced(r, priceOf);
    if (priced !== r) repricedCalls++;
    // Keyed on the record as stored (`r`), not the re-priced copy: what makes a
    // figure suspect is the generation that captured its *token counts*, and
    // re-pricing cannot recover a cached-input split that was never recorded.
    // So a recovered cost from a pre-v2 record is still potentially overstated.
    if (priced.costUsd != null && (r.pricingVersion ?? 0) < PRICING_VERSION) {
      legacyPricedCalls++;
      legacyPricedCostUsd += priced.costUsd;
    }
    store.record(priced);
  }
  const summary = store.summary();
  summary.repricedCalls = repricedCalls;
  summary.legacyPricedCalls = legacyPricedCalls;
  summary.legacyPricedCostUsd = legacyPricedCostUsd;
  // The store's `startedAt` is aggregation time (~now), so for a session
  // reconstructed from disk the real span must come from the record timestamps,
  // not `Date.now() - startedAt` (which would render `Duration: 0s`).
  const times = records.map((r) => Date.parse(r.ts)).filter((t) => Number.isFinite(t));
  if (times.length > 0) {
    summary.startedAt = Math.min(...times);
    summary.durationMs = Math.max(...times) - summary.startedAt;
  }
  return summary;
}

/** One right-padded label + right-aligned columns row for the plain-text report. */
function reportRow(
  label: string,
  tiers: string,
  calls: number,
  tin: number,
  tout: number,
  cost: string,
): string {
  // `truncate` (not bare padEnd): an over-long cell in a fixed-width grid shifts
  // every column to its right. Real labels overflow — `anthropic|claude-haiku-4-5-20251001`
  // is 35 chars — and so does `premium+mid+cheap` at 17.
  return (
    truncate(label, 25).padEnd(26) +
    truncate(tiers, 18).padEnd(19) +
    String(calls).padStart(7) +
    formatTokenCount(tin).padStart(10) +
    formatTokenCount(tout).padStart(10) +
    cost.padStart(11)
  );
}

function aggSection(title: string, map: Map<string, TelemetryAgg>, showTiers = true): string[] {
  const rows = sortedAggEntries(map);
  if (rows.length === 0) return [];
  const header =
    'name'.padEnd(26) +
    (showTiers ? 'tier' : '').padEnd(19) +
    'calls'.padStart(7) +
    'in'.padStart(10) +
    'out'.padStart(10) +
    '~cost'.padStart(11);
  const out = ['', title, header];
  for (const [key, agg] of rows) {
    out.push(
      reportRow(
        key,
        showTiers ? formatTiers(agg.tiers) : '',
        agg.calls,
        agg.promptTokens,
        agg.completionTokens,
        formatAggCost(agg.costUsd, agg.hasUnpriced),
      ),
    );
  }
  return out;
}

function treeLines(nodes: TelemetryTreeNode[], depth: number): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const indent = '  '.repeat(depth);
    const id = n.callId ?? 'off-loop';
    out.push(
      `${indent}${n.site} (${id}) · ${n.modelName} · ${n.calls} call(s) · ${formatTokenCount(
        n.promptTokens,
      )} in / ${formatTokenCount(n.completionTokens)} out · ${formatAggCost(
        n.costUsd,
        n.hasUnpriced,
      )}`,
    );
    if (n.children.length > 0) out.push(...treeLines(n.children, depth + 1));
  }
  return out;
}

/**
 * Render a {@link TelemetryAggregate} as plain-text report lines for the
 * `bernard usage` CLI. Pure — returns lines, prints nothing.
 */
export function formatSessionUsageLines(summary: TelemetryAggregate): string[] {
  const t = summary.totals;
  const lines: string[] = [];
  lines.push(`Bernard session: ${summary.sessionId}`);
  // The headline carries its own caveat because it is the line that gets read,
  // quoted and screenshotted on its own; the TOTAL block below is followed by
  // the full explanation a few lines later, so stamping both is redundant.
  const headlineCost =
    formatAggCost(t.costUsd, t.hasUnpriced) +
    costUpperBoundSuffix(t.costUsd, summary.legacyPricedCostUsd);
  lines.push(
    `Duration: ${formatElapsed(summary.durationMs)}   Calls: ${t.calls}   Cost: ${headlineCost}`,
  );
  lines.push('');
  lines.push('TOTAL');
  lines.push(`  Input tokens:  ${formatTokenCount(t.promptTokens)}`);
  lines.push(`  Output tokens: ${formatTokenCount(t.completionTokens)}`);
  if (t.cacheReadTokens > 0) lines.push(`  Cached (read): ${formatTokenCount(t.cacheReadTokens)}`);
  lines.push(`  Cost:          ${formatAggCost(t.costUsd, t.hasUnpriced)}`);
  if (t.hasUnpriced) lines.push('  (some calls used uncatalogued models; cost omits those)');
  if (summary.repricedCalls > 0) {
    lines.push(
      `  (${summary.repricedCalls} ${plural(summary.repricedCalls, 'call was', 'calls were')} ` +
        `stored unpriced and re-priced from the current catalog)`,
    );
  }
  if (summary.legacyPricedCalls > 0) {
    lines.push(
      `  (${summary.legacyPricedCalls} ${plural(summary.legacyPricedCalls, 'call predates', 'calls predate')} ` +
        `cache-aware token capture, so cost may be overstated — cached input is recorded as 0 ` +
        `and is billed here at the full input rate)`,
    );
  }

  lines.push(...aggSection('BY LAYER', summary.byLayer));
  lines.push(...aggSection('BY MODEL', summary.byModel));
  // A provider spans every tier by construction — the cell would be noise.
  lines.push(...aggSection('BY PROVIDER', summary.byProvider, false));

  if (summary.mostExpensiveCalls.length > 0) {
    lines.push('', 'MOST EXPENSIVE CALLS');
    for (const c of summary.mostExpensiveCalls) {
      lines.push(
        `  ${c.site} · ${c.modelName} · ${formatTokenCount(
          c.promptTokens + c.completionTokens,
        )} tok · ${formatCallCost(c.costUsd)}`,
      );
    }
  }

  if (summary.tree.length > 0) {
    lines.push('', 'TRACE (dispatch tree)');
    lines.push(...treeLines(summary.tree, 1));
  }
  return lines;
}
