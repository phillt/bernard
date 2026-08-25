import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_DIR, MODEL_CATALOG_CACHE } from '../paths.js';
import { debugLog } from '../logger.js';
import type { BuiltinProvider } from './types.js';
import { BUILTIN_PROVIDERS, resolveGatewayOwner } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/models';
const DEFAULT_TTL_HOURS = 24;
const FETCH_TIMEOUT_MS = 5000;

export type CatalogSource = 'network' | 'disk' | 'vendored';

/**
 * Per-million-token prices for a model. `input`/`output` are always present;
 * the cache rates are optional — `undefined` means the catalog has no cache
 * price for this model (unknown, must not be fabricated), distinct from a real
 * `0`. Anthropic prompt-caching (#269) reports cache-read (~0.1× input) and
 * cache-write (~1.25× input) tokens as **disjoint** from ordinary input tokens,
 * so each category is priced independently — see `priceUsageBreakdown`.
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface ModelCatalogEntry {
  provider: BuiltinProvider;
  /** Model id as accepted by the corresponding @ai-sdk/* provider SDK. */
  model: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  tags: string[];
  pricing: ModelPricing;
  /** Unix seconds the model was released (for recency tie-breaking). */
  released: number;
}

interface CachedCatalog {
  fetchedAt: number;
  source: CatalogSource;
  entries: ModelCatalogEntry[];
}

interface RawGatewayResponse {
  object: string;
  data: RawGatewayModel[];
}

interface RawGatewayModel {
  id: string;
  type?: string;
  name?: string;
  released?: number;
  context_window?: number;
  max_tokens?: number;
  tags?: string[];
  pricing?: {
    input?: string | number;
    output?: string | number;
    input_cache_read?: string | number;
    input_cache_write?: string | number;
  };
}

let memoryCache: CachedCatalog | null = null;
/**
 * Shared refresh promise. Always *resolves* (never rejects) so the
 * stale-while-revalidate path — which fires it without awaiting — can never
 * produce an unhandled rejection. The fetch error travels in the envelope
 * instead; forced callers unwrap it and re-throw (see {@link loadCatalog}).
 */
let inflight: Promise<{ catalog: CachedCatalog; error: Error | null }> | null = null;

/**
 * Anthropic gateway ids use dots (`claude-opus-4.6`) but the @ai-sdk/anthropic
 * SDK accepts dashes (`claude-opus-4-6`). OpenAI and xAI use dots in both
 * places. Apply the transform only for Anthropic so we hand the SDK a name it
 * recognises.
 */
function gatewayIdToModel(provider: BuiltinProvider, raw: string): string {
  if (provider === 'anthropic') return raw.replace(/\./g, '-');
  return raw;
}

function parseGatewayEntry(raw: RawGatewayModel): ModelCatalogEntry | null {
  if (raw.type && raw.type !== 'language') return null;
  const slash = raw.id.indexOf('/');
  if (slash < 0) return null;
  const owner = raw.id.slice(0, slash);
  const rest = raw.id.slice(slash + 1);
  const provider = resolveGatewayOwner(owner);
  if (!provider) return null;
  const inputPrice = Number(raw.pricing?.input ?? 0);
  const outputPrice = Number(raw.pricing?.output ?? 0);
  // Cache rates are optional in the source data — keep `undefined` when absent
  // (unknown) rather than coercing to 0 (which would price cache tokens as free).
  const perMTokOrUndefined = (v: string | number | undefined): number | undefined =>
    v == null ? undefined : Number(v) * 1_000_000;
  return {
    provider,
    model: gatewayIdToModel(provider, rest),
    displayName: raw.name ?? rest,
    contextWindow: raw.context_window ?? 0,
    maxOutputTokens: raw.max_tokens ?? 0,
    tags: raw.tags ?? [],
    // Convert per-token to per-million-tokens for human-readable numbers.
    pricing: {
      inputPerMTok: inputPrice * 1_000_000,
      outputPerMTok: outputPrice * 1_000_000,
      cacheReadPerMTok: perMTokOrUndefined(raw.pricing?.input_cache_read),
      cacheWritePerMTok: perMTokOrUndefined(raw.pricing?.input_cache_write),
    },
    released: raw.released ?? 0,
  };
}

function parseGatewayPayload(payload: RawGatewayResponse): ModelCatalogEntry[] {
  if (!payload || !Array.isArray(payload.data)) return [];
  const out: ModelCatalogEntry[] = [];
  for (const raw of payload.data) {
    const entry = parseGatewayEntry(raw);
    if (entry) out.push(entry);
  }
  return out;
}

function vendoredPath(): string {
  // Resolves to `<install-root>/data/model-catalog-fallback.json` whether
  // running compiled (`dist/providers/catalog.js`) or via tsx
  // (`src/providers/catalog.ts`). `copy-builtins.mjs` copies `src/data` to
  // `dist/data` so the same `..` walk works in both layouts.
  return path.join(__dirname, '..', 'data', 'model-catalog-fallback.json');
}

function loadVendored(): CachedCatalog {
  try {
    const raw = fs.readFileSync(vendoredPath(), 'utf-8');
    const payload = JSON.parse(raw) as RawGatewayResponse;
    return {
      fetchedAt: 0,
      source: 'vendored',
      entries: parseGatewayPayload(payload),
    };
  } catch (err) {
    debugLog('catalog:vendored:error', {
      message: err instanceof Error ? err.message : String(err),
    });
    return { fetchedAt: 0, source: 'vendored', entries: [] };
  }
}

/**
 * Disk-cache schema version. Bump whenever the persisted {@link ModelCatalogEntry}
 * shape changes so a cache written by an older Bernard is ignored (falls through
 * to the vendored snapshot + async refresh) rather than silently serving stale
 * data. v2 added `pricing.cacheReadPerMTok` / `pricing.cacheWritePerMTok` (#269);
 * an unversioned/older cache lacks them and would price cache tokens at $0.
 * v3 added the `spacexai` → `xai` owner mapping: a v2 cache was written by a
 * build that silently dropped every Grok entry, so it must be discarded rather
 * than served for up to another TTL window.
 */
export const CACHE_SCHEMA_VERSION = 3;

function loadDiskCache(): CachedCatalog | null {
  try {
    const raw = fs.readFileSync(MODEL_CATALOG_CACHE, 'utf-8');
    const parsed = JSON.parse(raw) as {
      version?: number;
      fetchedAt: number;
      entries: ModelCatalogEntry[];
    };
    // Ignore a cache from an older schema so new pricing fields aren't missing.
    if (parsed.version !== CACHE_SCHEMA_VERSION) return null;
    if (!Array.isArray(parsed.entries)) return null;
    return { fetchedAt: parsed.fetchedAt ?? 0, source: 'disk', entries: parsed.entries };
  } catch {
    return null;
  }
}

function saveDiskCache(entries: ModelCatalogEntry[], fetchedAt: number): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      MODEL_CATALOG_CACHE,
      JSON.stringify({ version: CACHE_SCHEMA_VERSION, fetchedAt, entries }, null, 2),
    );
  } catch (err) {
    debugLog('catalog:disk:write-error', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function ttlMs(): number {
  const hours = Number(process.env.BERNARD_CATALOG_TTL_HOURS);
  const v = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TTL_HOURS;
  return v * 60 * 60 * 1000;
}

async function fetchFromGateway(): Promise<ModelCatalogEntry[]> {
  debugLog('catalog:fetch:start', { url: GATEWAY_URL });
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(GATEWAY_URL, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = (await resp.json()) as RawGatewayResponse;
    const entries = parseGatewayPayload(payload);
    debugLog('catalog:fetch:end', {
      durationMs: Date.now() - t0,
      entries: entries.length,
    });
    return entries;
  } catch (err) {
    debugLog('catalog:fetch:error', {
      durationMs: Date.now() - t0,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Per-provider entry counts for the `catalog:source` log line. A bare total is
 * blind to the failure that matters most here: when the gateway renamed xAI's
 * owner prefix every Grok model was dropped, and the total read the same before
 * and after. A zero beside a provider you have configured is the signal.
 */
function countByProvider(entries: ModelCatalogEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of BUILTIN_PROVIDERS) counts[p] = 0;
  for (const e of entries) counts[e.provider] = (counts[e.provider] ?? 0) + 1;
  return counts;
}

/**
 * Synchronous load: reads the disk cache or the vendored snapshot. Never makes
 * a network call. Safe to call at module-init time for consumers that need a
 * catalog immediately (e.g. `PROVIDER_MODELS`).
 */
export function loadCatalogSync(): CachedCatalog {
  if (memoryCache) return memoryCache;
  const disk = loadDiskCache();
  if (disk) {
    memoryCache = disk;
    debugLog('catalog:source', {
      source: 'disk',
      entries: disk.entries.length,
      byProvider: countByProvider(disk.entries),
    });
    return disk;
  }
  const vendored = loadVendored();
  memoryCache = vendored;
  debugLog('catalog:source', {
    source: 'vendored',
    entries: vendored.entries.length,
    byProvider: countByProvider(vendored.entries),
  });
  return vendored;
}

/**
 * Async load with stale-while-revalidate. Returns the current catalog
 * immediately (loading synchronously if needed). When the cached copy is
 * older than the TTL — or when `force` is true — a background fetch refreshes
 * the disk cache + memory cache without blocking the caller.
 */
export async function loadCatalog(opts: { force?: boolean } = {}): Promise<CachedCatalog> {
  const current = loadCatalogSync();
  const stale = Date.now() - current.fetchedAt > ttlMs();
  if (!opts.force && !stale) return current;
  if (!inflight) {
    inflight = (async () => {
      try {
        const entries = await fetchFromGateway();
        const fetchedAt = Date.now();
        saveDiskCache(entries, fetchedAt);
        memoryCache = { fetchedAt, source: 'network', entries };
        debugLog('catalog:source', {
          source: 'network',
          entries: entries.length,
          byProvider: countByProvider(entries),
        });
        return { catalog: memoryCache, error: null };
      } catch (err) {
        debugLog('catalog:refresh-error', {
          message: err instanceof Error ? err.message : String(err),
        });
        return {
          catalog: current,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      } finally {
        inflight = null;
      }
    })();
  }
  if (opts.force) {
    // A forced refresh is user-initiated (`/refresh-models`) — surface the
    // fetch failure so the caller's error path is reachable instead of
    // silently reporting the stale catalog as "refreshed".
    const { catalog, error } = await inflight;
    if (error) throw error;
    return catalog;
  }
  // Stale-while-revalidate: don't await the refresh, return what we have.
  return current;
}

/** Returns all catalog entries for a single built-in provider. */
export function getCatalogForProvider(provider: BuiltinProvider): ModelCatalogEntry[] {
  const cat = loadCatalogSync();
  return cat.entries.filter((e) => e.provider === provider);
}

/**
 * Canonical form of a model id for tolerant catalog matching: lowercased, dots
 * folded to dashes, and a trailing release-date suffix dropped. Gateway ids and
 * the ids we configure diverge in exactly those three ways — the gateway says
 * `grok-4.1-fast-reasoning` where our lineup says `grok-4-1-fast-reasoning`, and
 * `claude-sonnet-4-5` where our lineup says `claude-sonnet-4-5-20250929`. An
 * exact-match-only lookup silently misses both and degrades to the hard-coded
 * table (or `null` pricing), so normalize before giving up.
 */
export function normalizeModelId(model: string): string {
  return model
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/-\d{8}$/, '');
}

/**
 * Exact match first, normalized match second — so a literal id always wins over
 * a punctuation-equivalent one, and the fallback only fires on a true miss.
 * `provider === undefined` searches every provider.
 */
function lookupEntry(model: string, provider?: string): ModelCatalogEntry | null {
  const { entries } = loadCatalogSync();
  const inScope = (e: ModelCatalogEntry): boolean =>
    provider === undefined || e.provider === provider;
  const exact = entries.find((e) => inScope(e) && e.model === model);
  if (exact) return exact;
  const key = normalizeModelId(model);
  return entries.find((e) => inScope(e) && normalizeModelId(e.model) === key) ?? null;
}

/** Look up a single (provider, model) pair. Returns null when unknown. */
export function getModelMeta(provider: string, model: string): ModelCatalogEntry | null {
  if (!BUILTIN_PROVIDERS.includes(provider as BuiltinProvider)) return null;
  return lookupEntry(model, provider);
}

/**
 * Look up a model by name across every built-in provider. Returns the first
 * match. Useful for call sites that only know the model id (e.g.
 * `getContextWindow`).
 */
export function findModelMetaByName(model: string): ModelCatalogEntry | null {
  return lookupEntry(model);
}

/** Catalog age in milliseconds, or `null` when sourced from the vendored fallback. */
export function getCatalogAgeMs(): number | null {
  const cat = loadCatalogSync();
  if (cat.source === 'vendored' || cat.fetchedAt === 0) return null;
  return Date.now() - cat.fetchedAt;
}

/** Where the in-memory catalog came from on its most recent load. */
export function getCatalogSource(): CatalogSource {
  return loadCatalogSync().source;
}

/** Stable identity for a catalog entry — `provider/model`. */
export function entryKey(e: ModelCatalogEntry): string {
  return `${e.provider}/${e.model}`;
}

/** Outcome of {@link refreshCatalogWithDiff}. */
export interface CatalogRefreshDiff {
  /** Entries present after the refresh but not before. */
  added: ModelCatalogEntry[];
  /** Entries present before the refresh but gone after. */
  removed: ModelCatalogEntry[];
  /** Total entry count after the refresh. */
  total: number;
  /**
   * Per-provider entry counts *after* the refresh, with every built-in provider
   * present (so a provider that lost everything reads as an explicit `0` rather
   * than a missing key). This is what makes "a whole provider vanished"
   * detectable: `removed` alone cannot distinguish pruning three stale models
   * from losing the only provider you have configured (#306).
   */
  byProvider: Record<string, number>;
  /** Source of the catalog after the refresh. */
  source: CatalogSource;
  /** Source of the catalog *before* the refresh (`'vendored'` ⇒ no real baseline). */
  previousSource: CatalogSource;
  /** Set when the forced network fetch failed; the diff is empty in that case. */
  error?: Error;
}

/**
 * Force-refresh the catalog from the gateway and report what changed relative
 * to the previously-loaded copy. Used by the REPL startup hook to notify the
 * user when new models become available.
 *
 * Never throws — a network failure is reported in `error` with an empty diff,
 * so startup is never blocked or crashed by an offline gateway. Callers should
 * treat `previousSource === 'vendored'` as "no real baseline" and skip
 * notifying (a fresh install diffing the bundled snapshot against the live
 * gateway would otherwise produce noise).
 */
export async function refreshCatalogWithDiff(): Promise<CatalogRefreshDiff> {
  const prev = loadCatalogSync();
  const previousSource = prev.source;
  const before = new Set(prev.entries.map(entryKey));
  try {
    const refreshed = await loadCatalog({ force: true });
    const afterKeys = new Set(refreshed.entries.map(entryKey));
    const added = refreshed.entries.filter((e) => !before.has(entryKey(e)));
    const removed = prev.entries.filter((e) => !afterKeys.has(entryKey(e)));
    const byProvider = countByProvider(refreshed.entries);
    if (removed.length > 0) {
      debugLog('catalog:removed', {
        count: removed.length,
        byProvider,
        models: removed.map(entryKey),
      });
    }
    return {
      added,
      removed,
      total: refreshed.entries.length,
      source: refreshed.source,
      previousSource,
      byProvider,
    };
  } catch (err) {
    return {
      added: [],
      removed: [],
      total: prev.entries.length,
      source: previousSource,
      previousSource,
      byProvider: countByProvider(prev.entries),
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/** Test-only hook to flush the in-memory cache so a fresh load is forced. */
export function _resetCatalogCacheForTests(): void {
  memoryCache = null;
  inflight = null;
}
