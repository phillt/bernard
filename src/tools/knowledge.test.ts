import { describe, it, expect, vi } from 'vitest';

/**
 * The `knowledge` tool's failure message (#607).
 *
 * `getEmbeddingProvider` answers `null` for two failures whose remedies are
 * opposite — a library that will not import, and a model download that was cut
 * off — and this tool reported "the embedding model is unavailable" for both.
 * The second one's remedy is to run the same command again, which the caller
 * can only act on if it is told.
 */
vi.mock('../embeddings.js', () => ({
  getEmbeddingProvider: vi.fn(async () => null),
  embeddingUnavailableReason: vi.fn(() => null as string | null),
}));

import { createKnowledgeTool } from './knowledge.js';
import { embeddingUnavailableReason } from '../embeddings.js';
import type { KnowledgeCorpus } from '../knowledge/corpus.js';

const corpus = {
  list: () => [{ id: 'books', title: 'Books', sources: 1, chunks: 2 }],
} as unknown as KnowledgeCorpus;

const run = (args: Record<string, unknown>): Promise<string> =>
  createKnowledgeTool(corpus).execute!(args as never, {
    toolCallId: 't',
    messages: [],
  }) as Promise<string>;

describe('knowledge — the embedding failure it reports', () => {
  it('names the reason when there is one', async () => {
    (embeddingUnavailableReason as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      'the embedding model went quiet for 120004 ms while loading, so the load was abandoned',
    );
    const out = await run({ action: 'search', query: 'anything' });
    expect(out).toMatch(/^Error: /);
    expect(out).toContain('went quiet');
  });

  it('falls back to the bare sentence when there is none', async () => {
    // The reason is best-effort state, not a guarantee — a `null` must still
    // produce a sentence rather than the word "null".
    (embeddingUnavailableReason as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const out = await run({ action: 'search', query: 'anything' });
    expect(out).toBe('Error: the embedding model is unavailable, so nothing can be read.');
  });
});
