import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CACHE_SCHEMA_VERSION } from './catalog.js';

/**
 * Tests for `refreshCatalogWithDiff` — the startup hook that force-refreshes
 * the model catalog and reports newly-available models (#264 follow-up).
 *
 * Each test seeds a baseline catalog on disk (so the "previous source" is a
 * real `disk` cache, not the vendored snapshot), stubs `fetch` to return a
 * controlled gateway payload, then asserts the diff.
 */

async function loadModule() {
  vi.resetModules();
  const mod = await import('./catalog.js');
  mod._resetCatalogCacheForTests();
  return mod;
}

interface GatewayModel {
  id: string;
  type?: string;
  name?: string;
}

function gatewayPayload(models: GatewayModel[]): string {
  return JSON.stringify({ object: 'list', data: models });
}

function stubFetchOk(models: GatewayModel[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => JSON.parse(gatewayPayload(models)),
    })),
  );
}

function stubFetchFail() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
  );
}

describe('refreshCatalogWithDiff', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-catalog-'));
    origHome = process.env.BERNARD_HOME;
    process.env.BERNARD_HOME = tmpDir;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (origHome === undefined) delete process.env.BERNARD_HOME;
    else process.env.BERNARD_HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Writes a `disk`-sourced baseline cache so previousSource === 'disk'. */
  function seedDiskCache(models: { provider: string; model: string }[]) {
    const entries = models.map((m) => ({
      provider: m.provider,
      model: m.model,
      displayName: m.model,
      contextWindow: 0,
      maxOutputTokens: 0,
      tags: [],
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      released: 0,
    }));
    // BERNARD_HOME isn't flat — CACHE_DIR is `<BERNARD_HOME>/bernard`.
    const cacheDir = path.join(tmpDir, 'bernard');
    fs.mkdirSync(cacheDir, { recursive: true });
    // fetchedAt=1 → stale → force still re-fetches; source is 'disk' on read.
    // Written at the live CACHE_SCHEMA_VERSION so the cache isn't rejected as
    // stale-schema — reading the constant keeps these fixtures from silently
    // going stale on the next schema bump.
    fs.writeFileSync(
      path.join(cacheDir, 'model-catalog.json'),
      JSON.stringify({ version: CACHE_SCHEMA_VERSION, fetchedAt: 1, entries }, null, 2),
    );
  }

  it('reports models present after the refresh but not before as added', async () => {
    seedDiskCache([{ provider: 'xai', model: 'grok-3-mini' }]);
    stubFetchOk([
      { id: 'xai/grok-3-mini', type: 'language' },
      { id: 'xai/grok-code-fast', type: 'language' },
    ]);
    const m = await loadModule();
    const diff = await m.refreshCatalogWithDiff();
    expect(diff.error).toBeUndefined();
    expect(diff.previousSource).toBe('disk');
    expect(diff.source).toBe('network');
    expect(diff.added.map((e) => e.model)).toEqual(['grok-code-fast']);
    expect(diff.removed).toEqual([]);
    expect(diff.total).toBe(2);
  });

  it('reports models gone after the refresh as removed', async () => {
    seedDiskCache([
      { provider: 'xai', model: 'grok-3-mini' },
      { provider: 'xai', model: 'grok-legacy' },
    ]);
    stubFetchOk([{ id: 'xai/grok-3-mini', type: 'language' }]);
    const m = await loadModule();
    const diff = await m.refreshCatalogWithDiff();
    expect(diff.added).toEqual([]);
    expect(diff.removed.map((e) => e.model)).toEqual(['grok-legacy']);
  });

  it('returns an empty diff with no error when nothing changed', async () => {
    seedDiskCache([{ provider: 'openai', model: 'gpt-4.1' }]);
    stubFetchOk([{ id: 'openai/gpt-4.1', type: 'language' }]);
    const m = await loadModule();
    const diff = await m.refreshCatalogWithDiff();
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.error).toBeUndefined();
  });

  it('surfaces a fetch failure as error with an empty diff (fail-silent)', async () => {
    seedDiskCache([{ provider: 'openai', model: 'gpt-4.1' }]);
    stubFetchFail();
    const m = await loadModule();
    const diff = await m.refreshCatalogWithDiff();
    expect(diff.error).toBeInstanceOf(Error);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    // Falls back to the prior catalog's source/count.
    expect(diff.previousSource).toBe('disk');
    expect(diff.total).toBe(1);
  });

  it('flags previousSource as vendored when there was no disk baseline', async () => {
    // No disk cache seeded → loadCatalogSync falls to the bundled snapshot.
    stubFetchOk([{ id: 'openai/gpt-4.1', type: 'language' }]);
    const m = await loadModule();
    const diff = await m.refreshCatalogWithDiff();
    expect(diff.previousSource).toBe('vendored');
  });
});

describe('gateway owner aliasing', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-catalog-owner-'));
    origHome = process.env.BERNARD_HOME;
    process.env.BERNARD_HOME = tmpDir;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (origHome === undefined) delete process.env.BERNARD_HOME;
    else process.env.BERNARD_HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('maps the spacexai owner prefix onto the xai provider', async () => {
    // The gateway renamed xAI's owner from `xai` to `spacexai`. Before the
    // alias every Grok entry was dropped at parse time, which silently cost us
    // both context windows and pricing for the whole provider.
    stubFetchOk([{ id: 'spacexai/grok-4.5', type: 'language' }]);
    const m = await loadModule();
    const diff = await m.refreshCatalogWithDiff();
    expect(diff.error).toBeUndefined();
    expect(m.getModelMeta('xai', 'grok-4.5')).not.toBeNull();
  });

  it('still accepts the legacy xai owner prefix', async () => {
    // An older vendored snapshot predates the rename — it must keep parsing.
    stubFetchOk([{ id: 'xai/grok-3-mini', type: 'language' }]);
    const m = await loadModule();
    await m.refreshCatalogWithDiff();
    expect(m.getModelMeta('xai', 'grok-3-mini')).not.toBeNull();
  });

  it('still drops owners that are not ours', async () => {
    stubFetchOk([{ id: 'mistral/mistral-large', type: 'language' }]);
    const m = await loadModule();
    await m.refreshCatalogWithDiff();
    expect(m.findModelMetaByName('mistral-large')).toBeNull();
  });
});

describe('normalizeModelId + tolerant lookup', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-catalog-norm-'));
    origHome = process.env.BERNARD_HOME;
    process.env.BERNARD_HOME = tmpDir;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (origHome === undefined) delete process.env.BERNARD_HOME;
    else process.env.BERNARD_HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('folds dots to dashes, lowercases, and strips a date suffix', async () => {
    const m = await loadModule();
    expect(m.normalizeModelId('grok-4.1-fast-reasoning')).toBe('grok-4-1-fast-reasoning');
    expect(m.normalizeModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(m.normalizeModelId('GPT-5.2')).toBe('gpt-5-2');
  });

  it('matches a dashed config id against a dotted gateway id', async () => {
    // Our lineup says `grok-4-1-fast-reasoning`; the gateway says
    // `grok-4.1-fast-reasoning`. Exact-match-only silently missed this and fell
    // back to the hard-coded table.
    stubFetchOk([{ id: 'spacexai/grok-4.1-fast-reasoning', type: 'language' }]);
    const m = await loadModule();
    await m.refreshCatalogWithDiff();
    expect(m.getModelMeta('xai', 'grok-4-1-fast-reasoning')?.model).toBe('grok-4.1-fast-reasoning');
    expect(m.findModelMetaByName('grok-4-1-fast-reasoning')).not.toBeNull();
  });

  it('matches a dated config id against the undated gateway id', async () => {
    stubFetchOk([{ id: 'anthropic/claude-sonnet-4.5', type: 'language' }]);
    const m = await loadModule();
    await m.refreshCatalogWithDiff();
    expect(m.getModelMeta('anthropic', 'claude-sonnet-4-5-20250929')?.model).toBe(
      'claude-sonnet-4-5',
    );
  });

  it('prefers an exact match over a normalized one', async () => {
    stubFetchOk([
      { id: 'anthropic/claude-sonnet-4.5', type: 'language' },
      { id: 'anthropic/claude-sonnet-4-5', type: 'language' },
    ]);
    const m = await loadModule();
    await m.refreshCatalogWithDiff();
    // Both normalize to the same key; the exact id must win.
    expect(m.getModelMeta('anthropic', 'claude-sonnet-4-5')?.model).toBe('claude-sonnet-4-5');
  });

  it('still returns null for a genuinely unknown model', async () => {
    stubFetchOk([{ id: 'spacexai/grok-4.5', type: 'language' }]);
    const m = await loadModule();
    await m.refreshCatalogWithDiff();
    expect(m.getModelMeta('xai', 'grok-9000')).toBeNull();
    expect(m.findModelMetaByName('grok-9000')).toBeNull();
  });
});

describe('disk-cache schema versioning (#269)', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-catalog-ver-'));
    origHome = process.env.BERNARD_HOME;
    process.env.BERNARD_HOME = tmpDir;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.BERNARD_HOME;
    else process.env.BERNARD_HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCache(obj: unknown) {
    const cacheDir = path.join(tmpDir, 'bernard');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'model-catalog.json'), JSON.stringify(obj, null, 2));
  }

  const fakeEntry = {
    provider: 'anthropic',
    model: 'stale-model',
    displayName: 'stale',
    contextWindow: 0,
    maxOutputTokens: 0,
    tags: [],
    pricing: { inputPerMTok: 1, outputPerMTok: 1 },
    released: 0,
  };

  it('ignores an unversioned (pre-cache-pricing) disk cache and uses vendored', async () => {
    writeCache({ fetchedAt: Date.now(), entries: [fakeEntry] });
    const m = await loadModule();
    const cat = m.loadCatalogSync();
    // The stale cache is rejected → vendored snapshot is served instead.
    expect(cat.source).toBe('vendored');
    expect(cat.entries.some((e: { model: string }) => e.model === 'stale-model')).toBe(false);
  });

  it('accepts a current-version disk cache', async () => {
    writeCache({ version: CACHE_SCHEMA_VERSION, fetchedAt: Date.now(), entries: [fakeEntry] });
    const m = await loadModule();
    const cat = m.loadCatalogSync();
    expect(cat.source).toBe('disk');
    expect(cat.entries.some((e: { model: string }) => e.model === 'stale-model')).toBe(true);
  });
});
