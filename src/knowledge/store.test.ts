import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import {
  KnowledgeStore,
  knowledgeStoreFor,
  closeAllKnowledgeStores,
  decodeVector,
  KNOWLEDGE_SCHEMA_VERSION,
  type ChunkInput,
} from './store.js';
import { knowledgeDir } from '../paths.js';

// Fake vectors throughout: this store does not know what a cosine is, and its
// tests must not need a 23 MB model download to prove it.
const STAMP = { model: 'fake/model-v1', dimensions: 4 };
const vec = (seed: number): Float32Array =>
  Float32Array.from([seed, seed * 0.5, seed * -0.25, 0.125]);

const chunk = (ordinal: number, text: string, extra: Partial<ChunkInput> = {}): ChunkInput => ({
  ordinal,
  text,
  charStart: ordinal * 100,
  charEnd: ordinal * 100 + text.length,
  prefixLen: 0,
  embedding: vec(ordinal + 1),
  ...extra,
});

const source = (uri: string, extra: Record<string, unknown> = {}) => ({
  uri,
  kind: 'file' as const,
  contentHash: 'hash-1',
  bytes: 100,
  chunkerVersion: 1,
  chunkTarget: 700,
  ingestedAt: '2026-09-08T00:00:00.000Z',
  ...extra,
});

let store: KnowledgeStore;

beforeEach(() => {
  store = new KnowledgeStore('testlib', STAMP);
});
afterEach(() => {
  closeAllKnowledgeStores();
  try {
    store.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(knowledgeDir('testlib'), { recursive: true, force: true });
});

describe('vector encoding', () => {
  it('round-trips bit-exactly', () => {
    // A float that survives JSON but not a blob is a whole-corpus silent zero.
    const original = Float32Array.from([0.1, -2.5, 1e-8, 3.4028234663852886e38]);
    store.replaceSource(source('/a.md'), [chunk(0, 'body', { embedding: original })]);
    const { vectors } = store.scanVectors(4);
    expect(Array.from(vectors[0].embedding)).toEqual(Array.from(original));
  });

  it('refuses a wrong-length blob rather than scoring it', () => {
    // Scored, it reaches cosineSimilarity, which returns 0 on a dimension
    // mismatch — the silent-empty failure the stamp prevents, one row at a time.
    expect(decodeVector(new Uint8Array(12), 4)).toBeNull();
    expect(decodeVector(new Uint8Array(16), 4)).not.toBeNull();
  });

  it('is little-endian regardless of host', () => {
    // Aliasing a Float32Array's buffer would make the file host-dependent, and
    // the failure would be garbage vectors rather than an error.
    store.replaceSource(source('/a.md'), [chunk(0, 'x', { embedding: Float32Array.from([1]) })]);
    const raw = store.scanVectors(1).vectors[0].embedding;
    expect(Array.from(raw)).toEqual([1]);
  });
});

describe('the stamp', () => {
  it('is written on create', () => {
    const s = store.stamp()!;
    expect(s.model).toBe('fake/model-v1');
    expect(s.dimensions).toBe(4);
    expect(s.schemaVersion).toBe(KNOWLEDGE_SCHEMA_VERSION);
  });

  it('accepts the embedder that wrote it', () => {
    expect(store.mismatchReason('fake/model-v1', 4)).toBeNull();
  });

  it('refuses a different model, and says the documents are intact', () => {
    const why = store.mismatchReason('other/model', 4)!;
    expect(why).toContain('fake/model-v1');
    expect(why).toContain('other/model');
    expect(why).toContain('intact');
  });

  it('refuses a different dimensionality', () => {
    // The realistic swap is a Matryoshka model truncated to fewer dimensions,
    // which keeps its id and changes its vector length — so comparing the name
    // alone lets it through.
    expect(store.mismatchReason('fake/model-v1', 8)).toContain('dimensions');
  });

  it('survives a reopen', () => {
    store.close();
    const again = new KnowledgeStore('testlib', { model: 'other', dimensions: 99 });
    // seedStamp leaves an existing stamp alone, so reopening with a different
    // embedder must not overwrite the record of what actually wrote the vectors.
    expect(again.stamp()!.model).toBe('fake/model-v1');
    expect(again.mismatchReason('other', 99)).not.toBeNull();
    again.close();
  });
});

describe('sources and chunks', () => {
  it('writes and reads a source with its chunks', () => {
    store.replaceSource(source('/a.md', { title: 'A' }), [chunk(0, 'one'), chunk(1, 'two')]);
    const [row] = store.listSources();
    expect(row.uri).toBe('/a.md');
    expect(row.title).toBe('A');
    expect(row.chunkCount).toBe(2);
    expect(store.stats()).toEqual({ sources: 1, chunks: 2, bytes: 100 });
  });

  it('replaces chunks wholesale, keeping the source id', () => {
    const id = store.replaceSource(source('/a.md'), [chunk(0, 'a'), chunk(1, 'b'), chunk(2, 'c')]);
    const again = store.replaceSource(source('/a.md', { contentHash: 'hash-2' }), [chunk(0, 'z')]);
    expect(again).toBe(id);
    // A source that SHRINKS must lose its tail. Upsert-by-ordinal would leave
    // ordinals 1 and 2 behind, still scored, forever.
    expect(store.stats().chunks).toBe(1);
    expect(store.getSource('/a.md')!.contentHash).toBe('hash-2');
  });

  it('rejects a duplicate ordinal rather than doubling a chunk', () => {
    expect(() => store.replaceSource(source('/a.md'), [chunk(0, 'a'), chunk(0, 'b')])).toThrow();
    // And the failed write left nothing behind.
    expect(store.stats().chunks).toBe(0);
  });

  it('rolls the whole source back on a mid-write failure', () => {
    store.replaceSource(source('/a.md'), [chunk(0, 'original')]);
    expect(() =>
      store.replaceSource(source('/a.md'), [chunk(0, 'new'), chunk(0, 'clash')]),
    ).toThrow();
    // Either the whole old set or the whole new one, never a blend.
    expect(store.chunksInRange(store.getSource('/a.md')!.id, 0, 9)[0].text).toBe('original');
  });

  it('reads a contiguous ordinal range in document order', () => {
    const id = store.replaceSource(
      source('/a.md'),
      Array.from({ length: 10 }, (_, i) => chunk(i, `chunk ${i}`)),
    );
    expect(store.chunksInRange(id, 3, 5).map((c) => c.ordinal)).toEqual([3, 4, 5]);
    // Clamping at the edges is the caller's business; the store just returns
    // what exists.
    expect(store.chunksInRange(id, 8, 20).map((c) => c.ordinal)).toEqual([8, 9]);
    expect(store.chunksInRange(id, -5, 1).map((c) => c.ordinal)).toEqual([0, 1]);
  });

  it('preserves heading and offsets', () => {
    const id = store.replaceSource(source('/a.md'), [
      chunk(0, 'body', { heading: 'Top > Nested', prefixLen: 7 }),
    ]);
    const [row] = store.chunksInRange(id, 0, 0);
    expect(row.heading).toBe('Top > Nested');
    expect(row.prefixLen).toBe(7);
    expect(row.charEnd - row.charStart).toBe(4);
  });
});

describe('deletion', () => {
  it('cascades chunks when a source is deleted', () => {
    // The whole reason `PRAGMA foreign_keys = ON` is set. It defaults to OFF,
    // per connection, and without it the chunks survive their source: they stay
    // in the dense scan forever and search returns text the user deleted.
    store.replaceSource(source('/a.md'), [chunk(0, 'a'), chunk(1, 'b')]);
    expect(store.deleteSource('/a.md')).toBe(true);
    expect(store.stats()).toEqual({ sources: 0, chunks: 0, bytes: 0 });
  });

  it('reports a delete of something that was not there', () => {
    expect(store.deleteSource('/missing.md')).toBe(false);
  });

  it('prunes only sources under the same root', () => {
    store.replaceSource(source('/docs/a.md', { root: '/docs' }), [chunk(0, 'a')]);
    store.replaceSource(source('/docs/b.md', { root: '/docs' }), [chunk(0, 'b')]);
    store.replaceSource(source('/other/c.md', { root: '/other' }), [chunk(0, 'c')]);
    store.replaceSource(source('/loose.md'), [chunk(0, 'd')]);

    const gone = store.pruneMissing('/docs', new Set(['/docs/a.md']));
    expect(gone).toEqual(['/docs/b.md']);
    // A single-file add owns no root, so a directory re-ingest must not touch
    // it — and another directory's sources are none of its business either.
    expect(store.listSources().map((s) => s.uri)).toEqual([
      '/docs/a.md',
      '/loose.md',
      '/other/c.md',
    ]);
  });
});

describe('write generation', () => {
  it('advances on every write, so a lexical index cannot be reused stale', () => {
    const start = store.writeGeneration;
    store.replaceSource(source('/a.md'), [chunk(0, 'a')]);
    expect(store.writeGeneration).toBe(start + 1);
    store.deleteSource('/a.md');
    expect(store.writeGeneration).toBe(start + 2);
  });

  it('does not advance on a delete that removed nothing', () => {
    const start = store.writeGeneration;
    store.deleteSource('/missing.md');
    expect(store.writeGeneration).toBe(start);
  });
});

describe('the library id', () => {
  it.each(['..', 'a/b', 'Docs', ''])('refuses %j rather than repairing it', (id) => {
    expect(() => new KnowledgeStore(id, STAMP)).toThrow(/valid library id/);
  });
});

describe('concurrent access', () => {
  it('lets two real connections write and read without SQLITE_BUSY', () => {
    // Two processes genuinely touch one file — an ingest in one terminal while
    // a REPL searches in another — so this opens two real connections rather
    // than hoping WAL and the busy timeout are configured.
    const a = new KnowledgeStore('testlib', STAMP);
    const b = new KnowledgeStore('testlib', STAMP);
    try {
      a.replaceSource(source('/a.md'), [chunk(0, 'from a')]);
      expect(b.getSource('/a.md')).not.toBeNull();
      b.replaceSource(source('/b.md'), [chunk(0, 'from b')]);
      expect(a.listSources()).toHaveLength(2);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('the connection cache', () => {
  afterEach(() => {
    fs.rmSync(knowledgeDir('cachedlib'), { recursive: true, force: true });
  });

  it('hands back one store per library', () => {
    const a = knowledgeStoreFor('cachedlib', STAMP);
    const b = knowledgeStoreFor('cachedlib', STAMP);
    expect(a).toBe(b);
  });

  it('reopens usably after a close', () => {
    // Asserted on USABILITY rather than object identity. `expect(x).not.toBe(a)`
    // serializes both operands when it fails, and walking a closed handle
    // throws `database is not open` — so the identity form reports a SQLite
    // error instead of the assertion that actually failed.
    knowledgeStoreFor('cachedlib', STAMP).replaceSource(source('/a.md'), [chunk(0, 'a')]);
    closeAllKnowledgeStores();
    const again = knowledgeStoreFor('cachedlib', STAMP);
    expect(again.stamp()!.model).toBe('fake/model-v1');
    expect(again.listSources()).toHaveLength(1);
  });
});

describe('file permissions', () => {
  it('creates the directory 0700 and the database 0600', () => {
    if (process.platform === 'win32') return;
    store.replaceSource(source('/a.md'), [chunk(0, 'a')]);
    expect(fs.statSync(knowledgeDir('testlib')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  });
});
