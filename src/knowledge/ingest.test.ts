import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chunkWithinBudget, contentHash, ingestFiles, collectSources } from './ingest.js';
import { KnowledgeStore, closeAllKnowledgeStores } from './store.js';
import { knowledgeDir } from '../paths.js';
import { EMBEDDING_MAX_WORD_PIECES } from '../embeddings.js';
import type { Extracted } from './extract.js';

const DIMS = 4;

/**
 * A provider whose word-piece count is a fixed ratio of characters, so the
 * verifier can be driven at prose (4.66), code (2.41) and CJK (1.00) ratios
 * without loading a 23 MB model.
 */
function fakeProvider(charsPerPiece: number | null) {
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0, 0]));
  return {
    embed,
    dimensions: () => DIMS,
    modelId: () => 'fake/model-v1',
    ...(charsPerPiece === null
      ? {}
      : {
          countWordPieces: vi.fn(async (texts: string[]) =>
            texts.map((t) => Math.ceil(t.length / charsPerPiece)),
          ),
        }),
  };
}

const doc = (uri: string, text: string, mode: 'prose' | 'code' = 'prose'): Extracted => ({
  uri,
  kind: 'file',
  text,
  mode,
  bytes: text.length,
});

const PROSE = 'The lighthouse keeper walked the shingle at dusk, counting gulls. '.repeat(60);

let store: KnowledgeStore;
beforeEach(() => {
  store = new KnowledgeStore('ingestlib', { model: 'fake/model-v1', dimensions: DIMS });
});
afterEach(() => {
  closeAllKnowledgeStores();
  try {
    store.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(knowledgeDir('ingestlib'), { recursive: true, force: true });
});

describe('chunkWithinBudget', () => {
  it('leaves prose alone — it already fits', async () => {
    const out = await chunkWithinBudget(PROSE, 'prose', fakeProvider(4.66));
    expect(out.verified).toBe(true);
    expect(out.overBudget).toBe(0);
    expect(out.target).toBe(700);
  });

  it('shrinks the target for code, which does NOT fit at 700', async () => {
    // The measurement this exists for: at a 700-character target a real code
    // chunk is 299 word pieces against a ceiling of 256. Without the re-split
    // it is truncated on most chunks, silently, because the embedder returns a
    // well-formed vector for a prefix.
    const out = await chunkWithinBudget(PROSE, 'code', fakeProvider(2.41));
    expect(out.target).toBeLessThan(700);
    expect(out.overBudget).toBe(0);
    for (const c of out.chunks) expect(Math.ceil(c.text.length / 2.41)).toBeLessThanOrEqual(256);
  });

  it('shrinks much further for a CJK ratio', async () => {
    const out = await chunkWithinBudget(
      '灯台守は夕暮れに歩いた。'.repeat(200),
      'prose',
      fakeProvider(1),
    );
    expect(out.target).toBeLessThanOrEqual(EMBEDDING_MAX_WORD_PIECES);
    expect(out.overBudget).toBe(0);
  });

  it('converges rather than looping', async () => {
    const provider = fakeProvider(1);
    await chunkWithinBudget(PROSE, 'prose', provider);
    // Each round is a pure re-chunk plus one tokenizer pass, and the scale
    // factor aims to land in one. More than a couple means the factor is wrong.
    expect(provider.countWordPieces!.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('reports verified:false when the provider cannot count', async () => {
    // Said out loud rather than assumed: the character estimate is wrong by
    // 2-4x on code and CJK, so "we did not check" is information.
    const out = await chunkWithinBudget(PROSE, 'prose', fakeProvider(null));
    expect(out.verified).toBe(false);
    expect(out.chunks.length).toBeGreaterThan(0);
  });

  it('gives up rather than shrinking to nothing', async () => {
    // A pathological ratio would otherwise drive the target toward zero and the
    // chunk count toward the character count.
    const out = await chunkWithinBudget(PROSE, 'prose', fakeProvider(0.01));
    expect(out.target).toBeGreaterThanOrEqual(64);
    expect(out.overBudget).toBeGreaterThan(0);
  });
});

describe('ingestFiles', () => {
  it('writes chunks and reports what it did', async () => {
    const out = await ingestFiles(store, fakeProvider(4.66), [doc('/a.md', PROSE)]);
    expect(out.ingested).toBe(1);
    expect(out.chunks).toBeGreaterThan(1);
    expect(store.stats().chunks).toBe(out.chunks);
  });

  it('is a no-op on an unchanged source, embedding nothing at all', async () => {
    const provider = fakeProvider(4.66);
    await ingestFiles(store, provider, [doc('/a.md', PROSE)]);
    const callsAfterFirst = provider.embed.mock.calls.length;

    const again = await ingestFiles(store, provider, [doc('/a.md', PROSE)]);
    expect(again.unchanged).toBe(1);
    expect(again.ingested).toBe(0);
    // The only way "idempotent" is checked rather than claimed.
    expect(provider.embed.mock.calls.length).toBe(callsAfterFirst);
  });

  it('re-ingests when the content changes', async () => {
    await ingestFiles(store, fakeProvider(4.66), [doc('/a.md', PROSE)]);
    const out = await ingestFiles(store, fakeProvider(4.66), [doc('/a.md', `${PROSE}\n\nNew.`)]);
    expect(out.ingested).toBe(1);
  });

  it('re-ingests when the chunker version moves, even though the bytes did not', async () => {
    // Without this a chunker fix silently never reaches content already stored.
    await ingestFiles(store, fakeProvider(4.66), [doc('/a.md', PROSE)]);
    const row = store.getSource('/a.md')!;
    store.replaceSource({ ...row, chunkerVersion: row.chunkerVersion - 1 }, []);
    const out = await ingestFiles(store, fakeProvider(4.66), [doc('/a.md', PROSE)]);
    expect(out.ingested).toBe(1);
  });

  it('honours force', async () => {
    await ingestFiles(store, fakeProvider(4.66), [doc('/a.md', PROSE)]);
    const out = await ingestFiles(store, fakeProvider(4.66), [doc('/a.md', PROSE)], {
      force: true,
    });
    expect(out.ingested).toBe(1);
  });

  it('reports progress per source', async () => {
    const seen: string[] = [];
    await ingestFiles(store, fakeProvider(4.66), [doc('/a.md', PROSE), doc('/b.md', PROSE)], {
      onProgress: (p) => seen.push(`${p.done}/${p.total} ${p.status}`),
    });
    expect(seen).toEqual(['1/2 ingested', '2/2 ingested']);
  });

  it('collects a failure and keeps going', async () => {
    const provider = fakeProvider(4.66);
    provider.embed.mockImplementationOnce(async () => {
      throw new Error('embedder exploded');
    });
    const out = await ingestFiles(store, provider, [doc('/a.md', PROSE), doc('/b.md', PROSE)]);
    // One bad source must not abort the other 199.
    expect(out.failed).toHaveLength(1);
    expect(out.ingested).toBe(1);
  });

  it('stores an empty source as zero chunks rather than skipping it', async () => {
    // Recorded, so the content hash makes it a no-op next time rather than a
    // file that is re-read on every ingest forever.
    const out = await ingestFiles(store, fakeProvider(4.66), [doc('/empty.md', '   \n\n')]);
    expect(out.ingested).toBe(1);
    expect(store.getSource('/empty.md')!.chunkCount).toBe(0);
  });

  it('tags sources with a root so a directory re-ingest can prune', async () => {
    await ingestFiles(store, fakeProvider(4.66), [doc('/docs/a.md', PROSE)], { root: '/docs' });
    expect(store.getSource('/docs/a.md')!.root).toBe('/docs');
  });
});

describe('contentHash', () => {
  it('is stable and content-sensitive', () => {
    expect(contentHash('alpha')).toBe(contentHash('alpha'));
    expect(contentHash('alpha')).not.toBe(contentHash('alphb'));
  });
});

describe('collectSources', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-collect-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('walks a directory', () => {
    fs.writeFileSync(path.join(root, 'a.md'), 'alpha');
    fs.writeFileSync(path.join(root, 'b.ts'), 'const b = 1;');
    const { documents } = collectSources([root]);
    expect(documents.map((d) => path.basename(d.uri))).toEqual(['a.md', 'b.ts']);
    expect(documents.find((d) => d.uri.endsWith('.ts'))!.mode).toBe('code');
  });

  it('takes a single file as itself', () => {
    const file = path.join(root, 'a.md');
    fs.writeFileSync(file, 'alpha');
    expect(collectSources([file]).documents.map((d) => d.uri)).toEqual([file]);
  });

  it('reports an empty directory as nothing, not as an unreadable file', () => {
    // Falling back to "treat the target as a file" on an empty walk would
    // report "no reader for a file with no extension" for a directory.
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    const { documents, failed } = collectSources([empty]);
    expect(documents).toEqual([]);
    expect(failed).toEqual([]);
  });

  it('reports a missing target', () => {
    expect(collectSources([path.join(root, 'nope')]).failed).toHaveLength(1);
  });
});
