import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
    fs.writeFileSync(
      path.join(cacheDir, 'model-catalog.json'),
      JSON.stringify({ fetchedAt: 1, entries }, null, 2),
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
