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
