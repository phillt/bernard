import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { KnowledgeCorpus } from './corpus.js';
import { KnowledgeStore, closeAllKnowledgeStores } from './store.js';
import { knowledgeDir } from '../paths.js';

const IDENTITY = { model: 'fake/model-v1', dimensions: 4 };
const LIBS = ['alpha', 'beta', 'gamma'];

/** Seeds a real library with one chunk whose text is its own id. */
function seed(id: string, text = `body of ${id}`): void {
  const store = new KnowledgeStore(id, IDENTITY);
  store.replaceSource(
    {
      uri: `/${id}.md`,
      kind: 'file',
      contentHash: 'h',
      bytes: 10,
      chunkerVersion: 1,
      chunkTarget: 700,
      ingestedAt: '2026-09-08T00:00:00.000Z',
    },
    [
      {
        ordinal: 0,
        text,
        charStart: 0,
        charEnd: text.length,
        prefixLen: 0,
        embedding: Float32Array.from([1, 0, 0, 0]),
      },
    ],
  );
  store.close();
}

beforeEach(() => {
  for (const id of LIBS) seed(id);
  closeAllKnowledgeStores();
});
afterEach(() => {
  closeAllKnowledgeStores();
  for (const id of LIBS) fs.rmSync(knowledgeDir(id), { recursive: true, force: true });
});

describe('an unscoped corpus', () => {
  it('lists every library', () => {
    expect(new KnowledgeCorpus(IDENTITY).listIds()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('opens any of them', () => {
    const corpus = new KnowledgeCorpus(IDENTITY);
    for (const id of LIBS) expect(corpus.open(id)).not.toBeNull();
  });

  it('summarises each one', () => {
    const [first] = new KnowledgeCorpus(IDENTITY).list();
    expect(first).toMatchObject({ id: 'alpha', sources: 1, chunks: 1 });
    expect(first.stamp!.model).toBe('fake/model-v1');
  });
});

describe('the fence', () => {
  it('lists only what it was granted', () => {
    expect(new KnowledgeCorpus(IDENTITY, ['alpha']).listIds()).toEqual(['alpha']);
  });

  it('refuses to open an out-of-scope library', () => {
    const fenced = new KnowledgeCorpus(IDENTITY, ['alpha']);
    expect(fenced.open('alpha')).not.toBeNull();
    expect(fenced.open('beta')).toBeNull();
  });

  it('answers the same way for out-of-scope and absent', () => {
    // Distinguishing them would leak the corpus catalogue past the fence — the
    // reasoning `assets.ts` gives for 404-not-403.
    const fenced = new KnowledgeCorpus(IDENTITY, ['alpha']);
    expect(fenced.open('beta')).toBeNull();
    expect(fenced.open('never-existed')).toBeNull();
  });

  it('treats an empty scope as deny-all, not as unscoped', () => {
    // `[]` and `null` are different postures and the difference is the whole
    // fence: one is "nothing", the other is "everything".
    expect(new KnowledgeCorpus(IDENTITY, []).listIds()).toEqual([]);
    expect(new KnowledgeCorpus(IDENTITY, []).open('alpha')).toBeNull();
    expect(new KnowledgeCorpus(IDENTITY, null).listIds()).toHaveLength(3);
  });

  it('refuses a malformed id without touching the filesystem', () => {
    const corpus = new KnowledgeCorpus(IDENTITY);
    for (const bad of ['..', 'a/b', 'Alpha', '']) expect(corpus.open(bad)).toBeNull();
  });
});

describe('scoped()', () => {
  it('narrows and never widens', () => {
    const corpus = new KnowledgeCorpus(IDENTITY, ['alpha']);
    // A view asking for more than it inherited gets the intersection.
    expect(corpus.scoped(['alpha', 'beta']).listIds()).toEqual(['alpha']);
    expect(corpus.scoped(['beta']).listIds()).toEqual([]);
  });

  it('is idempotent, which is what makes scoping early and re-deriving safe', () => {
    // Two call sites scope before the runner sees the input and let the runner
    // scope again. That is only safe because narrowing twice is narrowing once.
    const once = new KnowledgeCorpus(IDENTITY).scoped(['alpha']);
    expect(once.scoped(['alpha']).listIds()).toEqual(once.listIds());
  });

  it('returns the receiver for an absent scope', () => {
    // One place decides what an absent scope means, so no caller needs a guard.
    const corpus = new KnowledgeCorpus(IDENTITY);
    expect(corpus.scoped(undefined)).toBe(corpus);
    expect(corpus.scoped(null)).toBe(corpus);
  });

  it('has nothing mutable for a clone to fork', () => {
    // The trap `rag.ts` documents: a per-instance flag copied into a shallow
    // clone makes the view's bookkeeping stop reaching the original. This class
    // holds only a scope array and a stamp; the write generation lives on the
    // store, which is shared through the module-level connection cache.
    const root = new KnowledgeCorpus(IDENTITY);
    const view = root.scoped(['alpha']);
    expect(root.open('alpha')).toBe(view.open('alpha'));
  });
});

describe('a corpus with nothing in it', () => {
  it('is empty rather than an error when the directory does not exist', () => {
    for (const id of LIBS) fs.rmSync(knowledgeDir(id), { recursive: true, force: true });
    fs.rmSync(knowledgeDir(''), { recursive: true, force: true });
    // Reached from context assembly, which must not fail because nobody has
    // ingested anything yet.
    expect(new KnowledgeCorpus(IDENTITY).listIds()).toEqual([]);
    expect(new KnowledgeCorpus(IDENTITY).list()).toEqual([]);
  });

  it('ignores a directory with no database in it', () => {
    fs.mkdirSync(knowledgeDir('halfmade'), { recursive: true });
    try {
      expect(new KnowledgeCorpus(IDENTITY).listIds()).not.toContain('halfmade');
    } finally {
      fs.rmSync(knowledgeDir('halfmade'), { recursive: true, force: true });
    }
  });
});
