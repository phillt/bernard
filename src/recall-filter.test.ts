import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('./providers/index.js', () => ({
  getModel: vi.fn(() => ({ modelId: 'mock' })),
  getModelForConfig: vi.fn(() => ({ modelId: 'mock' })),
  getProviderOptions: vi.fn(() => undefined),
  getProviderOptionsForConfig: vi.fn(() => undefined),
}));

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
  traceLlm: <T>(_site: string, _model: string, fn: () => Promise<T>) => fn(),
}));

const generateTextMock = vi.fn();
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
  };
});

import { recallFilter } from './recall-filter.js';
import type { RAGStore, RAGSearchResultWithId } from './rag.js';
import type { BernardConfig } from './config.js';
import { clearLLMCache } from './llm-cache.js';
import type { CoreMessage } from 'ai';

function makeConfig(overrides?: Partial<BernardConfig>): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-test',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    maxSteps: 25,
    ragEnabled: true,
    cacheEnabled: true,
    theme: 'bernard',
    coordinatorMode: 'off',
    recallFilter: true,
    ...overrides,
  } as BernardConfig;
}

/** Builds a candidate fact with sensible defaults for the extended-metadata shape. */
function candidate(id: string, fact: string, domain = 'general'): RAGSearchResultWithId {
  return { id, fact, similarity: 0.5, domain, createdAt: '2026-01-01T00:00:00Z', accessCount: 1 };
}

function makeRagStore(candidates: RAGSearchResultWithId[]) {
  const searchWithIds = vi.fn(async () => candidates);
  const recordAccess = vi.fn();
  const store = { searchWithIds, recordAccess } as unknown as RAGStore;
  return { store, searchWithIds, recordAccess };
}

const HISTORY: CoreMessage[] = [];

beforeEach(() => {
  generateTextMock.mockReset();
  clearLLMCache();
});

describe('recallFilter', () => {
  it('keeps only the LLM-selected subset and returns it stripped to the 3-field shape', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ keep: [1, 3] }) });
    const { store } = makeRagStore([
      candidate('a', 'fact one'),
      candidate('b', 'fact two'),
      candidate('c', 'fact three', 'tool-usage'),
    ]);

    const result = await recallFilter('what should I do', makeConfig(), store, HISTORY);

    expect(result.status).toBe('filtered');
    if (result.status !== 'filtered') return;
    expect(result.facts.map((f) => f.fact)).toEqual(['fact one', 'fact three']);
    // Stripped: no id/createdAt/accessCount leak downstream.
    expect(Object.keys(result.facts[0]).sort()).toEqual(['domain', 'fact', 'similarity']);
  });

  it('widens the candidate net beyond store defaults', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ keep: [] }) });
    const { store, searchWithIds } = makeRagStore([candidate('a', 'x')]);

    await recallFilter('hello there', makeConfig(), store, HISTORY);

    expect(searchWithIds).toHaveBeenCalledTimes(1);
    const overrides = searchWithIds.mock.calls[0][1] as {
      threshold: number;
      topKPerDomain: number;
      maxResults: number;
    };
    // Looser than the store defaults (0.35 / 5 / 15).
    expect(overrides.threshold).toBeLessThan(0.35);
    expect(overrides.topKPerDomain).toBeGreaterThan(5);
    expect(overrides.maxResults).toBeGreaterThan(15);
  });

  it('records access for exactly the kept facts', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ keep: [2] }) });
    const { store, recordAccess } = makeRagStore([
      candidate('a', 'fact one'),
      candidate('b', 'fact two'),
    ]);

    await recallFilter('pick one', makeConfig(), store, HISTORY);

    expect(recordAccess).toHaveBeenCalledWith(['b']);
  });

  it('returns filtered-empty when the LLM keeps nothing', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ keep: [] }) });
    const { store, recordAccess } = makeRagStore([candidate('a', 'fact one')]);

    const result = await recallFilter('unrelated ask', makeConfig(), store, HISTORY);

    expect(result.status).toBe('filtered');
    if (result.status !== 'filtered') return;
    expect(result.facts).toEqual([]);
    expect(recordAccess).toHaveBeenCalledWith([]);
  });

  it('noops (no LLM call) when there are no candidates', async () => {
    const { store, searchWithIds } = makeRagStore([]);

    const result = await recallFilter('anything', makeConfig(), store, HISTORY);

    expect(result.status).toBe('noop');
    expect(searchWithIds).toHaveBeenCalledTimes(1);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('noops (fail-open) when the LLM throws', async () => {
    generateTextMock.mockRejectedValue(new Error('boom'));
    const { store } = makeRagStore([candidate('a', 'fact one')]);

    const result = await recallFilter('question', makeConfig(), store, HISTORY);

    expect(result.status).toBe('noop');
  });

  it('noops (fail-open) when the response is unparseable', async () => {
    generateTextMock.mockResolvedValue({ text: 'not json at all' });
    const { store, recordAccess } = makeRagStore([candidate('a', 'fact one')]);

    const result = await recallFilter('question', makeConfig(), store, HISTORY);

    expect(result.status).toBe('noop');
    expect(recordAccess).not.toHaveBeenCalled();
  });

  it('ignores out-of-range indices in the keep list', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ keep: [1, 99, 0, -2] }) });
    const { store } = makeRagStore([candidate('a', 'fact one'), candidate('b', 'fact two')]);

    const result = await recallFilter('q', makeConfig(), store, HISTORY);

    expect(result.status).toBe('filtered');
    if (result.status !== 'filtered') return;
    expect(result.facts.map((f) => f.fact)).toEqual(['fact one']);
  });
});
