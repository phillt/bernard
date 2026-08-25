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
    byProvider: { anthropic: 0, openai: 0, xai: 0 },
    ...over,
  };
}

describe('catalogRefreshNotice', () => {
  it('says nothing when the refresh failed', () => {
    const n = catalogRefreshNotice(
      diff({ error: new Error('offline'), removed: [entry('xai', 'grok-3-mini')] }),
      { providersInUse: ['xai'] },
    );
    // A failed fetch is not news about the catalog's contents, and the diff is
    // empty by construction — reporting it would be a false alarm.
    expect(n.kind).toBe('none');
  });

  it('says nothing when there was no real baseline (fresh install)', () => {
    const n = catalogRefreshNotice(
      diff({ previousSource: 'vendored', added: [entry('xai', 'grok-4-fast')] }),
      { providersInUse: ['xai'] },
    );
    expect(n.kind).toBe('none');
  });

  it('escalates to provider-wiped when a provider in use loses every entry', () => {
    const n = catalogRefreshNotice(
      diff({
        removed: [entry('xai', 'grok-3-mini'), entry('xai', 'grok-4-fast')],
        byProvider: { anthropic: 12, openai: 20, xai: 0 },
      }),
      { providersInUse: ['xai', 'anthropic'] },
    );
    expect(n.kind).toBe('provider-wiped');
    expect(n.wipedProviders).toEqual(['xai']);
    expect(n.message).toContain('xai');
  });

  it('does not escalate when the wiped provider is not one this session uses', () => {
    const n = catalogRefreshNotice(
      diff({
        removed: [entry('xai', 'grok-3-mini')],
        byProvider: { anthropic: 12, openai: 20, xai: 0 },
      }),
      { providersInUse: ['anthropic'] },
    );
    expect(n.kind).toBe('removed');
    expect(n.wipedProviders).toEqual([]);
  });

  it('does not escalate for a provider that was already at zero and lost nothing', () => {
    // `byProvider` seeds every built-in provider to 0, so "count is 0" alone
    // would fire on every startup for a provider never in the catalog. The
    // signal is losing entries AND landing at zero.
    const n = catalogRefreshNotice(
      diff({
        added: [entry('openai', 'gpt-5.2')],
        byProvider: { anthropic: 0, openai: 20, xai: 0 },
      }),
      { providersInUse: ['xai', 'anthropic'] },
    );
    expect(n.kind).toBe('added');
  });

  it('reports a partial removal as removed, not wiped', () => {
    const n = catalogRefreshNotice(
      diff({
        removed: [entry('xai', 'grok-legacy')],
        byProvider: { anthropic: 0, openai: 0, xai: 4 },
      }),
      { providersInUse: ['xai'] },
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
      { providersInUse: ['xai'] },
    );
    expect(n.kind).toBe('removed');
  });

  it('reports additions, preserving the pre-#306 message', () => {
    const n = catalogRefreshNotice(
      diff({ added: [entry('openai', 'gpt-5.2')], byProvider: { openai: 1 } }),
      { providersInUse: ['openai'] },
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
      { providersInUse: ['openai'] },
    );
    expect(n.message).toContain('openai/a, openai/b, openai/c +2 more');
  });

  it('says nothing when nothing changed', () => {
    expect(catalogRefreshNotice(diff(), { providersInUse: ['xai'] }).kind).toBe('none');
  });
});
