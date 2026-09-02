import { describe, it, expect } from 'vitest';
import { ProvenanceStore, extractCitationMarkers } from './provenance.js';

describe('ProvenanceStore', () => {
  it('assigns sequential S<n> ids', () => {
    const s = new ProvenanceStore();
    expect(s.add({ kind: 'web', label: 'a', contentPreview: '', rawRef: 'https://a' })).toBe('S1');
    expect(s.add({ kind: 'web', label: 'b', contentPreview: '', rawRef: 'https://b' })).toBe('S2');
    expect(s.add({ kind: 'file', label: 'c', contentPreview: '', rawRef: 'path:1-5' })).toBe('S3');
    expect(s.size()).toBe(3);
  });

  it('dedups on kind+rawRef and returns the existing id', () => {
    const s = new ProvenanceStore();
    const first = s.add({ kind: 'web', label: 'a', contentPreview: '', rawRef: 'https://a' });
    const second = s.add({
      kind: 'web',
      label: 'a2',
      contentPreview: 'different',
      rawRef: 'https://a',
    });
    expect(second).toBe(first);
    expect(s.size()).toBe(1);
  });

  it('upgrades the stored preview/label when a duplicate carries richer detail', () => {
    // web_search registers a snippet first; web_read then fetches the full page.
    const s = new ProvenanceStore();
    s.add({ kind: 'web', label: 'short', contentPreview: 'snippet', rawRef: 'https://x' });
    s.add({
      kind: 'web',
      label: 'Full page title',
      contentPreview: 'the full page content is longer than the snippet',
      rawRef: 'https://x',
    });
    const item = s.list()[0];
    expect(item.contentPreview).toBe('the full page content is longer than the snippet');
    expect(item.label).toBe('Full page title');
  });

  it('does not regress a richer preview when a later call has a shorter one', () => {
    const s = new ProvenanceStore();
    s.add({
      kind: 'web',
      label: 'Full',
      contentPreview: 'the full page content',
      rawRef: 'https://x',
    });
    s.add({ kind: 'web', label: 's', contentPreview: 'snip', rawRef: 'https://x' });
    const item = s.list()[0];
    expect(item.contentPreview).toBe('the full page content');
    expect(item.label).toBe('Full');
  });

  it('treats same rawRef but different kind as distinct sources', () => {
    const s = new ProvenanceStore();
    const a = s.add({ kind: 'web', label: 'x', contentPreview: '', rawRef: 'thing' });
    const b = s.add({ kind: 'memory', label: 'x', contentPreview: '', rawRef: 'thing' });
    expect(a).not.toBe(b);
    expect(s.size()).toBe(2);
  });

  it('retains a substantial preview but truncates beyond the cap with ellipsis', () => {
    const s = new ProvenanceStore();
    // A 1 KB excerpt is kept verbatim so the Sources viewer can show real content…
    const kept = 'x'.repeat(1000);
    s.add({ kind: 'web', label: 'a', contentPreview: kept, rawRef: 'https://a' });
    expect(s.list()[0].contentPreview).toBe(kept);

    // …while anything past the 2000-char cap is still trimmed with an ellipsis.
    const s2 = new ProvenanceStore();
    s2.add({ kind: 'web', label: 'b', contentPreview: 'y'.repeat(5000), rawRef: 'https://b' });
    const item = s2.list()[0];
    expect(item.contentPreview.length).toBeLessThanOrEqual(2001);
    expect(item.contentPreview.length).toBeGreaterThan(2000);
    expect(item.contentPreview.endsWith('…')).toBe(true);
  });

  it('list() returns a copy — mutations do not affect the store', () => {
    const s = new ProvenanceStore();
    s.add({ kind: 'web', label: 'a', contentPreview: '', rawRef: 'https://a' });
    const list = s.list();
    list.pop();
    expect(s.size()).toBe(1);
  });

  it('get() returns the item by id or undefined', () => {
    const s = new ProvenanceStore();
    s.add({ kind: 'web', label: 'a', contentPreview: 'hello', rawRef: 'https://a' });
    expect(s.get('S1')?.label).toBe('a');
    expect(s.get('S99')).toBeUndefined();
  });

  it('clear() resets ids and items', () => {
    const s = new ProvenanceStore();
    s.add({ kind: 'web', label: 'a', contentPreview: '', rawRef: 'https://a' });
    s.add({ kind: 'web', label: 'b', contentPreview: '', rawRef: 'https://b' });
    s.clear();
    expect(s.size()).toBe(0);
    expect(s.add({ kind: 'web', label: 'c', contentPreview: '', rawRef: 'https://c' })).toBe('S1');
  });
});

describe('extractCitationMarkers', () => {
  it('extracts [^Sn] markers in order, deduped', () => {
    const text = 'Sky is blue [^S1]. Water is wet [^S2]. Sky is also blue [^S1].';
    expect(extractCitationMarkers(text)).toEqual(['S1', 'S2']);
  });

  it('returns empty array when no markers are present', () => {
    expect(extractCitationMarkers('No citations here.')).toEqual([]);
  });

  it('ignores malformed markers like [^Sx] or [^1]', () => {
    expect(extractCitationMarkers('Bad [^Sx] and [^1] and [^S].')).toEqual([]);
  });

  it('filters out ids missing from a provided store', () => {
    const s = new ProvenanceStore();
    s.add({ kind: 'web', label: 'a', contentPreview: '', rawRef: 'https://a' }); // S1
    const text = 'Real [^S1]. Stale [^S2]. Also real [^S1].';
    expect(extractCitationMarkers(text, s)).toEqual(['S1']);
  });
});

// #417: an evidence item's age is part of the claim, and "when we fetched it"
// is not the same fact as "when it was written".
describe('publication dates', () => {
  it('keeps publishedAt distinct from the retrieval timestamp', () => {
    const store = new ProvenanceStore();
    const id = store.add({
      kind: 'web',
      label: 'Old Post',
      contentPreview: 'x',
      rawRef: 'https://example.com/a',
      publishedAt: '2019-03-01T00:00:00.000Z',
    });
    const item = store.get(id)!;
    expect(item.publishedAt).toBe('2019-03-01T00:00:00.000Z');
    expect(item.timestamp).toBeGreaterThan(Date.parse('2020-01-01'));
  });

  it('leaves publishedAt undefined rather than falling back to retrieval time', () => {
    const store = new ProvenanceStore();
    const id = store.add({ kind: 'web', label: 'x', contentPreview: 'x', rawRef: 'u' });
    expect(store.get(id)!.publishedAt).toBeUndefined();
  });

  // The common case: web_search registers a URL from a provider that reports no
  // date, then web_read of the same URL registers one. Dedup must not lose it.
  it('upgrades an unknown date when a later registration knows it', () => {
    const store = new ProvenanceStore();
    const first = store.add({ kind: 'web', label: 'x', contentPreview: 'snip', rawRef: 'u' });
    const second = store.add({
      kind: 'web',
      label: 'x',
      contentPreview: 'full page',
      rawRef: 'u',
      publishedAt: '2026-01-05',
    });
    expect(second).toBe(first);
    expect(store.get(first)!.publishedAt).toBe('2026-01-05');
  });

  it('never overwrites a known date with an unknown one', () => {
    const store = new ProvenanceStore();
    const id = store.add({
      kind: 'web',
      label: 'x',
      contentPreview: 'a',
      rawRef: 'u',
      publishedAt: '2026-01-05',
    });
    store.add({ kind: 'web', label: 'x', contentPreview: 'a longer preview', rawRef: 'u' });
    expect(store.get(id)!.publishedAt).toBe('2026-01-05');
  });
});

// #417: the quote check needs the text a quote could have come from. Before
// this, the only copy addressable by source id was the 2,000-char preview, so a
// quote from the middle of a page read as fabricated.
describe('verifyText retention', () => {
  const long = 'A'.repeat(5000) + 'NEEDLE' + 'B'.repeat(5000);

  it('retains far more than the context preview', () => {
    const store = new ProvenanceStore();
    const id = store.add({
      kind: 'web',
      label: 'x',
      contentPreview: long,
      rawRef: 'u',
      verifyText: long,
    });
    const item = store.get(id)!;
    // The preview is capped because it is re-sent every turn; verifyText is not.
    expect(item.contentPreview.length).toBeLessThanOrEqual(2001);
    expect(item.verifyText).toContain('NEEDLE');
  });

  // The case that was impossible before: a span past the preview cap.
  it('can answer whether a quote past the preview cap appears in the source', () => {
    const store = new ProvenanceStore();
    const id = store.add({
      kind: 'web',
      label: 'x',
      contentPreview: long,
      rawRef: 'u',
      verifyText: long,
    });
    expect(store.get(id)!.verifyText!.includes('NEEDLE')).toBe(true);
    expect(store.get(id)!.contentPreview.includes('NEEDLE')).toBe(false);
  });

  it('caps one enormous page rather than storing it whole', () => {
    const store = new ProvenanceStore();
    const id = store.add({
      kind: 'web',
      label: 'x',
      contentPreview: 'p',
      rawRef: 'u',
      verifyText: 'C'.repeat(50_000),
    });
    expect(store.get(id)!.verifyText!.length).toBe(20_000);
  });

  it('upgrades a snippet-only source when the full read arrives', () => {
    const store = new ProvenanceStore();
    const id = store.add({ kind: 'web', label: 'x', contentPreview: 'snip', rawRef: 'u' });
    store.add({ kind: 'web', label: 'x', contentPreview: long, rawRef: 'u', verifyText: long });
    expect(store.get(id)!.verifyText).toContain('NEEDLE');
  });

  it('is undefined for sources whose full text is not retained', () => {
    const store = new ProvenanceStore();
    const id = store.add({ kind: 'memory', label: 'k', contentPreview: 'v', rawRef: 'memory:k' });
    expect(store.get(id)!.verifyText).toBeUndefined();
  });
});
