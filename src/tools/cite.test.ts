import { describe, it, expect } from 'vitest';
import { createCiteTool } from './cite.js';
import { ProvenanceStore } from '../provenance.js';

describe('cite tool', () => {
  it('list returns an empty sources array with a note when store is empty', async () => {
    const store = new ProvenanceStore();
    const tool = createCiteTool(store);
    const out = await tool.execute!({ action: 'list' } as any, {} as any);
    const parsed = JSON.parse(out as string);
    expect(parsed.sources).toEqual([]);
    expect(parsed.note).toBeTruthy();
  });

  it('list returns every registered source with id/kind/label/preview', async () => {
    const store = new ProvenanceStore();
    store.add({ kind: 'web', label: 'Title A', contentPreview: 'preview A', rawRef: 'https://a' });
    store.add({
      kind: 'file',
      label: 'path:1-5',
      contentPreview: 'preview B',
      rawRef: '/tmp/x.txt:1-5',
    });
    const tool = createCiteTool(store);
    const out = await tool.execute!({ action: 'list' } as any, {} as any);
    const parsed = JSON.parse(out as string);
    expect(parsed.sources).toHaveLength(2);
    expect(parsed.sources[0]).toMatchObject({
      id: 'S1',
      kind: 'web',
      label: 'Title A',
      preview: 'preview A',
    });
    expect(parsed.sources[1]).toMatchObject({ id: 'S2', kind: 'file' });
  });

  it('get returns the full SourceItem including rawRef', async () => {
    const store = new ProvenanceStore();
    store.add({ kind: 'web', label: 'Title A', contentPreview: 'preview A', rawRef: 'https://a' });
    const tool = createCiteTool(store);
    const out = await tool.execute!({ action: 'get', id: 'S1' } as any, {} as any);
    const parsed = JSON.parse(out as string);
    expect(parsed.source).toMatchObject({
      id: 'S1',
      kind: 'web',
      label: 'Title A',
      rawRef: 'https://a',
    });
  });

  it('get returns an error when the id is missing', async () => {
    const store = new ProvenanceStore();
    const tool = createCiteTool(store);
    const out = await tool.execute!({ action: 'get' } as any, {} as any);
    const parsed = JSON.parse(out as string);
    expect(parsed.error).toMatch(/id is required/i);
  });

  it('get returns an error when the id is unknown', async () => {
    const store = new ProvenanceStore();
    const tool = createCiteTool(store);
    const out = await tool.execute!({ action: 'get', id: 'S99' } as any, {} as any);
    const parsed = JSON.parse(out as string);
    expect(parsed.error).toMatch(/No source registered/i);
  });
});
