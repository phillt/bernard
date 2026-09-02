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

// #417: verifyText exists so a quote can be checked against the full page
// WITHOUT paying to put that page into the model's context. Returning it from
// `cite get` would defeat exactly that — up to 20k chars per call.
describe('cite does not leak verification text', () => {
  it('omits verifyText from a get, while keeping the rest of the item', async () => {
    const store = new ProvenanceStore();
    const id = store.add({
      kind: 'web',
      label: 'Page',
      contentPreview: 'preview',
      rawRef: 'https://e.com/a',
      publishedAt: '2026-01-01',
      verifyText: 'X'.repeat(9000),
    });
    const tool = createCiteTool(store);

    const parsed = JSON.parse(
      (await tool.execute!({ action: 'get', id } as any, {} as any)) as string,
    );

    expect(parsed.source.verifyText).toBeUndefined();
    expect(parsed.source.id).toBe(id);
    expect(parsed.source.rawRef).toBe('https://e.com/a');
    expect(parsed.source.publishedAt).toBe('2026-01-01');
    expect(JSON.stringify(parsed).length).toBeLessThan(1000);
  });

  it('leaves the stored item intact', async () => {
    const store = new ProvenanceStore();
    const id = store.add({
      kind: 'web',
      label: 'Page',
      contentPreview: 'p',
      rawRef: 'u',
      verifyText: 'kept',
    });
    await createCiteTool(store).execute!({ action: 'get', id } as any, {} as any);
    expect(store.get(id)!.verifyText).toBe('kept');
  });
});
