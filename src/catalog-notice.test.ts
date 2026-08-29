import { describe, it, expect } from 'vitest';

import { catalogRefreshNotice } from './catalog-notice.js';
import type { CatalogRefreshDiff } from './providers/catalog.js';
import type { ModelCatalogEntry } from './providers/types.js';

/**
 * `catalogRefreshNotice` is the #306 decision: what a catalog refresh warrants
 * telling the user. Pure, so these tests need no catalog, no network, and no
 * Ink tree — the surfacing (toast vs. durable transcript notice) is App's.
 */

function entry(provider: string, model: string): ModelCatalogEntry {
  return {
    provider,
    model,
    displayName: model,
    contextWindow: 0,
    maxOutputTokens: 0,
    tags: [],
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    released: 0,
  } as ModelCatalogEntry;
}

function diff(over: Partial<CatalogRefreshDiff> = {}): CatalogRefreshDiff {
  return {
    added: [],
    removed: [],
    total: 0,
    source: 'network',
    previousSource: 'disk',
    byProvider: { anthropic: 15, openai: 57, xai: 12 },
    ...over,
  };
}

/**
 * Options factory. `vendoredByProvider` defaults to the real snapshot's shape —
 * every built-in non-zero — so the carried-over check is armed by default and a
 * case that wants it disarmed has to say so explicitly.
 */
function opts(over: Partial<Parameters<typeof catalogRefreshNotice>[1]> = {}) {
  return {
    providersInUse: [] as string[],
    vendoredByProvider: { anthropic: 15, openai: 57, xai: 12 },
    ...over,
  };
}

describe('catalogRefreshNotice', () => {
  it('says nothing when the refresh failed', () => {
    const n = catalogRefreshNotice(
      diff({ error: new Error('offline'), removed: [entry('xai', 'grok-3-mini')] }),
      opts({ providersInUse: ['xai'] }),
    );
    // A failed fetch is not news about the catalog's contents, and the diff is
    // empty by construction — reporting it would be a false alarm.
    expect(n.kind).toBe('none');
  });

  it('says nothing when there was no real baseline (fresh install)', () => {
    const n = catalogRefreshNotice(
      diff({ previousSource: 'vendored', added: [entry('xai', 'grok-4-fast')] }),
      opts({ providersInUse: ['xai'] }),
    );
    expect(n.kind).toBe('none');
  });

  it('escalates to provider-wiped when a provider in use loses every entry', () => {
    const n = catalogRefreshNotice(
      diff({
        removed: [entry('xai', 'grok-3-mini'), entry('xai', 'grok-4-fast')],
        byProvider: { anthropic: 12, openai: 20, xai: 0 },
      }),
      opts({ providersInUse: ['xai', 'anthropic'] }),
    );
    expect(n.kind).toBe('provider-wiped');
    expect(n.message).toContain('xai');
  });

  it('does not escalate when the wiped provider is not one this session uses', () => {
    const n = catalogRefreshNotice(
      diff({
        removed: [entry('xai', 'grok-3-mini')],
        byProvider: { anthropic: 12, openai: 20, xai: 0 },
      }),
      opts({ providersInUse: ['anthropic'] }),
    );
    expect(n.kind).toBe('removed');
  });

  it('does not escalate for a provider the bundled snapshot never had either', () => {
    // `byProvider` seeds every built-in to 0, so "count is 0" alone would fire
    // on every startup for a provider never catalogued. The vendored snapshot
    // is the discriminator: zero on BOTH sides is not a loss.
    const n = catalogRefreshNotice(
      diff({
        added: [entry('openai', 'gpt-5.2')],
        byProvider: { anthropic: 15, openai: 20, xai: 0 },
      }),
      opts({
        providersInUse: ['xai'],
        vendoredByProvider: { anthropic: 15, openai: 57, xai: 0 },
      }),
    );
    expect(n.kind).toBe('added');
  });

  it('reports a partial removal as removed, not wiped', () => {
    const n = catalogRefreshNotice(
      diff({
        removed: [entry('xai', 'grok-legacy')],
        byProvider: { anthropic: 0, openai: 0, xai: 4 },
      }),
      opts({ providersInUse: ['xai'] }),
    );
    expect(n.kind).toBe('removed');
    expect(n.message).toContain('xai/grok-legacy');
  });

  it('prefers a removal over an addition when a refresh does both', () => {
    const n = catalogRefreshNotice(
      diff({
        added: [entry('openai', 'gpt-5.2')],
        removed: [entry('xai', 'grok-legacy')],
        byProvider: { anthropic: 0, openai: 1, xai: 4 },
      }),
      opts({ providersInUse: ['xai'] }),
    );
    expect(n.kind).toBe('removed');
  });

  it('reports additions, preserving the pre-#306 message', () => {
    const n = catalogRefreshNotice(
      diff({ added: [entry('openai', 'gpt-5.2')], byProvider: { openai: 1 } }),
      opts({ providersInUse: ['openai'] }),
    );
    expect(n.kind).toBe('added');
    expect(n.message).toContain('1 new model available: openai/gpt-5.2');
    expect(n.message).toContain('/lineup');
  });

  it('truncates long lists to three names plus a count', () => {
    const n = catalogRefreshNotice(
      diff({
        added: ['a', 'b', 'c', 'd', 'e'].map((m) => entry('openai', m)),
        byProvider: { openai: 5 },
      }),
      opts({ providersInUse: ['openai'] }),
    );
    expect(n.message).toContain('openai/a, openai/b, openai/c +2 more');
  });

  it('says nothing when nothing changed', () => {
    expect(catalogRefreshNotice(diff(), opts({ providersInUse: ['xai'] })).kind).toBe('none');
  });
});

describe('catalogRefreshNotice — a cache carried over from a previous run (#387)', () => {
  /** Nothing removed *now*, but the provider is already gone from the catalog. */
  const poisoned = { byProvider: { anthropic: 15, openai: 57, xai: 0 } };

  it('reports a configured provider the catalog has no entries for', () => {
    // The gap #306 left: a poisoned cache written by an earlier run yields
    // `removed: []`, so every diff-driven check says nothing and each later
    // session inherits the damage silently.
    const n = catalogRefreshNotice(diff(poisoned), opts({ providersInUse: ['xai'] }));
    expect(n.kind).toBe('provider-empty');
    expect(n.message).toContain('xai');
    expect(n.message).toContain('/refresh-models');
  });

  it('ignores a provider this session does not use', () => {
    const n = catalogRefreshNotice(diff(poisoned), opts({ providersInUse: ['anthropic'] }));
    expect(n.kind).toBe('none');
  });

  it('still fires when the refresh itself failed', () => {
    // Offline AND serving a bad cache is the worst case, not a reason to hush.
    const n = catalogRefreshNotice(
      diff({ ...poisoned, error: new Error('offline') }),
      opts({ providersInUse: ['xai'] }),
    );
    expect(n.kind).toBe('provider-empty');
  });

  it('still fires on a fresh install whose first fetch drops a provider', () => {
    const n = catalogRefreshNotice(
      diff({ ...poisoned, previousSource: 'vendored' }),
      opts({ providersInUse: ['xai'] }),
    );
    expect(n.kind).toBe('provider-empty');
  });

  it('yields to provider-wiped, which carries the richer detail', () => {
    // Losing entries in THIS refresh is the more specific story; announcing
    // both would report one outage twice.
    const n = catalogRefreshNotice(
      diff({ ...poisoned, removed: [entry('xai', 'grok-4.5')] }),
      opts({ providersInUse: ['xai'] }),
    );
    expect(n.kind).toBe('provider-wiped');
  });

  it('names every affected provider', () => {
    const n = catalogRefreshNotice(
      diff({ byProvider: { anthropic: 0, openai: 57, xai: 0 } }),
      opts({ providersInUse: ['xai', 'anthropic'] }),
    );
    expect(n.kind).toBe('provider-empty');
    expect(n.message).toContain('anthropic');
    expect(n.message).toContain('xai');
  });
});
