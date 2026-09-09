import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTempHome } from './__tests__/temp-home.js';

/**
 * A RAG store per specialist, against a REAL directory (#501).
 *
 * `rag.test.ts` mocks `node:fs` wholesale, which is right for ranking and
 * useless here: the question is whether two stores actually address different
 * files, and a mock can only answer with whatever it was told to say. That gap
 * is why the `dir` option shipped with no test that it was honoured — deleting
 * it left 103 tests green.
 */
useTempHome('bernard-rag-per-store');

const provider = {
  embed: async (texts: string[]) => texts.map((t) => [t.length % 7, 1, 0]),
  dimensions: () => 3,
  modelId: () => 'fake/model-v1',
};

vi.mock('./embeddings.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getEmbeddingProvider: async () => provider,
}));

let RAGStore: typeof import('./rag.js').RAGStore;
let specialistRagDir: (id: string) => string;

beforeEach(async () => {
  vi.resetModules();
  RAGStore = (await import('./rag.js')).RAGStore;
  specialistRagDir = (await import('./paths.js')).specialistRagDir;
});

describe('a store per specialist', () => {
  it('keeps two specialists’ facts apart', async () => {
    const coder = new RAGStore({ dir: specialistRagDir('coder') });
    await coder.addFacts(['Use pnpm to install.'], 'exit');
    const designer = new RAGStore({ dir: specialistRagDir('designer') });
    await designer.addFacts(['Buttons use the accent token.'], 'exit');

    expect(coder.listFacts().join(' ')).toContain('Use pnpm to install.');
    expect(designer.listFacts().join(' ')).toContain('Buttons use the accent token.');
    expect(coder.listFacts().join(' ')).not.toContain('accent token');
  });

  it('keeps them out of the user’s own store', async () => {
    // The fence that matters: the main agent asks a specialist a question, it
    // does not inherit what the specialist learned.
    const coder = new RAGStore({ dir: specialistRagDir('coder') });
    await coder.addFacts(['Use pnpm to install.'], 'exit');
    expect(new RAGStore().listFacts()).toEqual([]);
  });

  it('writes into its own directory, not the shared one', async () => {
    const fs = await import('node:fs');
    const coder = new RAGStore({ dir: specialistRagDir('coder') });
    await coder.addFacts(['Use pnpm to install.'], 'exit');
    expect(fs.existsSync(`${specialistRagDir('coder')}/memories.json`)).toBe(true);
  });

  it('gives each store its own cap, so one cannot evict another', async () => {
    // The whole reason this is a store per owner rather than a namespace
    // column: `maxMemories`, the dedup scan and `prune()` are per-INSTANCE, so
    // separate directories make each of them per-owner for free. A namespace
    // would have competed with the user's history in one global score sort.
    const tiny = new RAGStore({ dir: specialistRagDir('tiny'), maxMemories: 1 });
    await tiny.addFacts(['first fact here'], 'exit');
    await tiny.addFacts(['second fact here'], 'exit');
    expect(tiny.listFacts().length).toBe(1);

    const other = new RAGStore({ dir: specialistRagDir('other') });
    await other.addFacts(['unaffected fact'], 'exit');
    expect(other.listFacts().length).toBe(1);
  });

  it('reloads what it persisted', async () => {
    const first = new RAGStore({ dir: specialistRagDir('coder') });
    await first.addFacts(['Use pnpm to install.'], 'exit');
    const second = new RAGStore({ dir: specialistRagDir('coder') });
    expect(second.listFacts().join(' ')).toContain('Use pnpm to install.');
  });
});
