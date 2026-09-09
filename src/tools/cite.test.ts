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

describe('cite locate (#549)', () => {
  const store = () => {
    const p = new ProvenanceStore();
    p.add({
      kind: 'web',
      label: 'Handbook',
      contentPreview: 'The default timeout is 30 seconds.',
      rawRef: 'https://example.test/handbook',
      verifyText: `${'padding. '.repeat(300)}The default timeout is 30 seconds. Tail.`,
    });
    return p;
  };

  it('finds a span past the preview cap, in the retained text', async () => {
    // The whole reason verifyText exists: a quote from character 3,000 of a
    // long page reads as fabricated when only the 2,000-char preview is
    // searched.
    const out = JSON.parse(
      await createCiteTool(store()).execute(
        { action: 'locate', quote: 'default timeout is 30 seconds' },
        {} as never,
      ),
    );
    expect(out.found).toBe(true);
    expect(out.sourceId).toBe('S1');
    expect(out.start).toBeGreaterThan(2000);
    expect(out.fromPreview).toBe(false);
    expect(out.rawRef).toBe('https://example.test/handbook');
  });

  it('returns a bounded window, never the whole retained text', async () => {
    // Withholding it is the entire point of the field — `get` strips it for the
    // same reason. The model already saw this text when the tool ran.
    const out = JSON.parse(
      await createCiteTool(store()).execute(
        { action: 'locate', quote: 'default timeout' },
        {} as never,
      ),
    );
    expect(out.context.length).toBeLessThan(1200);
    expect(out.context).toContain('default timeout');
  });

  it('says which sources it searched when it finds nothing', async () => {
    const out = JSON.parse(
      await createCiteTool(store()).execute(
        { action: 'locate', quote: 'never written anywhere' },
        {} as never,
      ),
    );
    expect(out.found).toBe(false);
    expect(out.searched).toEqual(['S1']);
  });

  it('marks sources where only the preview could be searched', async () => {
    // "Not found" and "not found in the first 2,000 characters" are different
    // answers, and a caller has to be able to tell them apart.
    const p = new ProvenanceStore();
    p.add({ kind: 'memory', label: 'm', contentPreview: 'short', rawRef: 'memory:k' });
    const out = JSON.parse(
      await createCiteTool(p).execute({ action: 'locate', quote: 'absent' }, {} as never),
    );
    expect(out.partial).toEqual(['S1']);
  });

  it('requires a quote', async () => {
    const out = JSON.parse(
      await createCiteTool(store()).execute({ action: 'locate' }, {} as never),
    );
    expect(out.error).toMatch(/quote is required/);
  });
});
