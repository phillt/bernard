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
import { MAX_PERSISTENT_MEMORY_CHARS } from './context-message.js';
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

/** Minimal MemoryStore stub — the curator only reads `getAllMemoryContents`. */
function makeMemoryStore(entries: Record<string, string>) {
  return {
    getAllMemoryContents: () => new Map(Object.entries(entries)),
  } as unknown as import('./memory.js').MemoryStore;
}

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

describe('recallFilter — memory reconciliation (#371)', () => {
  const MEMORY = {
    'daily-blaze-no-time': 'Daily Blaze emails no longer include a Time line.',
    'email-accounts': 'Work mail is phil@phoneburner.com.',
  };

  it('passes curated memory to the model as authoritative context', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ keep: [1] }) });
    const { store } = makeRagStore([candidate('a', 'template includes Time ~X hrs')]);

    await recallFilter('draft my blaze', makeConfig(), store, HISTORY, {
      memoryStore: makeMemoryStore(MEMORY),
    });

    const sent = generateTextMock.mock.calls[0][0];
    expect(sent.messages[0].content).toContain('Curated memory');
    expect(sent.messages[0].content).toContain('daily-blaze-no-time');
  });

  it('returns the reconciliation note when the model supplies one', async () => {
    const note = 'The memory overrides the Time line; the rest of the template stands.';
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ keep: [1], reconciliation: note }),
    });
    const { store } = makeRagStore([candidate('a', 'template includes Time ~X hrs')]);

    const result = await recallFilter('draft my blaze', makeConfig(), store, HISTORY, {
      memoryStore: makeMemoryStore(MEMORY),
    });

    expect(result.status).toBe('filtered');
    if (result.status !== 'filtered') return;
    expect(result.reconciliation).toBe(note);
    // Facts stay verbatim — the note sits beside them, never merged in.
    expect(result.facts[0].fact).toBe('template includes Time ~X hrs');
  });

  it.each([
    ['null', { keep: [1], reconciliation: null }],
    ['absent', { keep: [1] }],
    ['blank', { keep: [1], reconciliation: '   ' }],
  ])('leaves reconciliation undefined when %s', async (_label, raw) => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify(raw) });
    const { store } = makeRagStore([candidate('a', 'x')]);
    const result = await recallFilter('q', makeConfig(), store, HISTORY, {
      memoryStore: makeMemoryStore(MEMORY),
    });
    if (result.status !== 'filtered') throw new Error('expected filtered');
    expect(result.reconciliation).toBeUndefined();
  });

  it('does NOT ask for a memory ranking when memory fits the budget', async () => {
    // Asking unconditionally costs a verbatim echo of every key — serial output
    // tokens on a blocking pass — for a ranking nothing will consult.
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ keep: [1] }) });
    const { store } = makeRagStore([candidate('a', 'x')]);

    await recallFilter('q', makeConfig(), store, HISTORY, {
      memoryStore: makeMemoryStore(MEMORY),
    });

    expect(generateTextMock.mock.calls[0][0].system).not.toContain('memoryPriority');
  });

  it('asks for a memory ranking only once memory is over budget', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ keep: [1] }) });
    const { store } = makeRagStore([candidate('a', 'x')]);
    const huge = { a: 'x'.repeat(MAX_PERSISTENT_MEMORY_CHARS + 1) };

    await recallFilter('q', makeConfig(), store, HISTORY, {
      memoryStore: makeMemoryStore(huge),
    });

    const system = generateTextMock.mock.calls[0][0].system;
    expect(system).toContain('memoryPriority');
    // A topical ranker would bury a standing rule; the prompt must say not to.
    expect(system).toContain('standing rule');
  });

  it('never shows the curator `rewriter-hints` — internal infra, not user-curated', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ keep: [1] }) });
    const { store } = makeRagStore([candidate('a', 'x')]);

    await recallFilter('q', makeConfig(), store, HISTORY, {
      memoryStore: makeMemoryStore({ ...MEMORY, 'rewriter-hints': 'internal resolver state' }),
    });

    const sent = generateTextMock.mock.calls[0][0].messages[0].content;
    expect(sent).toContain('daily-blaze-no-time');
    expect(sent).not.toContain('rewriter-hints');
  });

  it('bounds the memory block so the curator never sees more than the agent', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ keep: [1] }) });
    const { store } = makeRagStore([candidate('a', 'x')]);
    const many = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`k${i}`, 'y'.repeat(400)]),
    );

    await recallFilter('q', makeConfig(), store, HISTORY, { memoryStore: makeMemoryStore(many) });

    const sent = generateTextMock.mock.calls[0][0].messages[0].content as string;
    expect(sent).toContain('more entries omitted');
    const block = sent.slice(sent.indexOf('## Curated memory'));
    expect(block.length).toBeLessThanOrEqual(MAX_PERSISTENT_MEMORY_CHARS + 500);
  });

  it('keeps the selection when only the note is malformed', async () => {
    // Selection is the job the pipeline cannot cheaply fall back from; a bad
    // note must not discard a good pick.
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ keep: [1], reconciliation: 42, memoryPriority: 'nonsense' }),
    });
    const { store } = makeRagStore([candidate('a', 'fact one')]);

    const result = await recallFilter('q', makeConfig(), store, HISTORY, {
      memoryStore: makeMemoryStore(MEMORY),
    });

    expect(result.status).toBe('filtered');
    if (result.status !== 'filtered') return;
    expect(result.facts.map((f) => f.fact)).toEqual(['fact one']);
    expect(result.reconciliation).toBeUndefined();
    expect(result.memoryPriority).toBeUndefined();
  });

  it('drops memoryPriority keys that do not exist', async () => {
    // A hallucinated key would otherwise reorder real entries around a ghost.
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        keep: [1],
        memoryPriority: ['email-accounts', 'invented-key', 'daily-blaze-no-time'],
      }),
    });
    const { store } = makeRagStore([candidate('a', 'x')]);

    const result = await recallFilter('q', makeConfig(), store, HISTORY, {
      memoryStore: makeMemoryStore(MEMORY),
    });

    if (result.status !== 'filtered') throw new Error('expected filtered');
    expect(result.memoryPriority).toEqual(['email-accounts', 'daily-blaze-no-time']);
  });

  it('works with no memory store at all (headless / tests)', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ keep: [1] }) });
    const { store } = makeRagStore([candidate('a', 'x')]);

    const result = await recallFilter('q', makeConfig(), store, HISTORY);

    expect(result.status).toBe('filtered');
    const sent = generateTextMock.mock.calls[0][0];
    expect(sent.messages[0].content).not.toContain('Curated memory');
  });
});
