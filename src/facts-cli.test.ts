import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// --- Hoisted mocks ---

const mockRAGStore = vi.hoisted(() => ({
  listMemories: vi.fn().mockReturnValue([]),
  searchWithIds: vi.fn().mockResolvedValue([]),
  deleteByIds: vi.fn().mockReturnValue(0),
  count: vi.fn().mockReturnValue(0),
  countByDomain: vi.fn().mockReturnValue({}),
  clear: vi.fn(),
}));

const mockOutput = vi.hoisted(() => ({
  printInfo: vi.fn(),
  printError: vi.fn(),
}));

const mockConfig = vi.hoisted(() => ({
  loadConfig: vi.fn().mockReturnValue({ ragEnabled: true }),
}));

vi.mock('./rag.js', () => ({
  RAGStore: vi.fn(() => mockRAGStore),
}));

vi.mock('./output.js', () => mockOutput);

vi.mock('./config.js', () => mockConfig);

vi.mock('./domains.js', () => ({
  getDomain: vi.fn((id: string) => {
    const domains: Record<string, { id: string; name: string }> = {
      'tool-usage': { id: 'tool-usage', name: 'Tool Usage Patterns' },
      'user-preferences': { id: 'user-preferences', name: 'User Preferences' },
      general: { id: 'general', name: 'General Knowledge' },
    };
    return domains[id] ?? domains['general'];
  }),
}));

// Mock readline to auto-respond to prompts
let promptAnswer = '';
let confirmAnswer = 'y';
let clearConfirmAnswer = '';

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_prompt: string, cb: (answer: string) => void) => {
      // Distinguish between selection prompt, clear-rag confirm, and y/N confirm
      if (_prompt.includes('delete all facts')) {
        cb(clearConfirmAnswer);
      } else if (_prompt.includes('Enter fact numbers')) {
        cb(promptAnswer);
      } else {
        cb(confirmAnswer);
      }
    }),
    close: vi.fn(),
  })),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const fs = await import('node:fs');

import { factsList, factsSearch, parseSelection, clearFacts } from './facts-cli.js';

afterAll(() => {
  vi.restoreAllMocks();
});

// --- Helpers ---

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem-1',
    fact: 'npm run build compiles TypeScript to dist/',
    similarity: 0.92,
    domain: 'tool-usage',
    createdAt: '2025-06-01T00:00:00.000Z',
    accessCount: 3,
    ...overrides,
  };
}

function infoMessages(): string[] {
  return mockOutput.printInfo.mock.calls.map((c: unknown[]) => c[0] as string);
}

// --- Tests ---

describe('parseSelection', () => {
  it('parses single numbers', () => {
    expect(parseSelection('1', 5)).toEqual([1]);
    expect(parseSelection('3', 5)).toEqual([3]);
  });

  it('parses comma-separated numbers', () => {
    expect(parseSelection('1,3,5', 5)).toEqual([1, 3, 5]);
  });

  it('parses ranges', () => {
    expect(parseSelection('2-4', 5)).toEqual([2, 3, 4]);
  });

  it('parses mixed numbers and ranges', () => {
    expect(parseSelection('1,3-5,8', 10)).toEqual([1, 3, 4, 5, 8]);
  });

  it('deduplicates overlapping selections', () => {
    expect(parseSelection('1,1,2-3,3', 5)).toEqual([1, 2, 3]);
  });

  it('returns null for empty input', () => {
    expect(parseSelection('', 5)).toBeNull();
  });

  it('returns null for out of range', () => {
    expect(parseSelection('0', 5)).toBeNull();
    expect(parseSelection('6', 5)).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(parseSelection('abc', 5)).toBeNull();
    expect(parseSelection('1,abc', 5)).toBeNull();
  });

  it('returns null for reversed ranges', () => {
    expect(parseSelection('5-2', 5)).toBeNull();
  });
});

describe('factsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.loadConfig.mockReturnValue({ ragEnabled: true });
    mockRAGStore.listMemories.mockReturnValue([]);
    promptAnswer = '';
    confirmAnswer = 'y';
  });

  it('shows message when RAG is disabled', async () => {
    mockConfig.loadConfig.mockReturnValue({ ragEnabled: false });
    await factsList();
    expect(infoMessages().some((m) => m.includes('RAG is disabled'))).toBe(true);
  });

  it('shows message when store is empty', async () => {
    await factsList();
    expect(infoMessages()).toContain('No facts stored.');
  });

  it('displays facts grouped by domain without similarity', async () => {
    mockRAGStore.listMemories.mockReturnValue([
      makeResult({ id: 'a', domain: 'tool-usage', fact: 'npm run build' }),
      makeResult({ id: 'b', domain: 'user-preferences', fact: 'prefers dark mode' }),
    ]);

    await factsList();

    const msgs = infoMessages();
    expect(msgs.some((m) => m.includes('2 facts'))).toBe(true);
    expect(msgs.some((m) => m.includes('Tool Usage Patterns'))).toBe(true);
    expect(msgs.some((m) => m.includes('User Preferences'))).toBe(true);
    // Should NOT include percentage
    expect(msgs.some((m) => m.includes('%)') && m.includes('npm run build'))).toBe(false);
    expect(msgs.some((m) => m.includes('1.') && m.includes('npm run build'))).toBe(true);
    expect(msgs.some((m) => m.includes('2.') && m.includes('prefers dark mode'))).toBe(true);
  });

  it('handles deletion flow', async () => {
    const results = [
      makeResult({ id: 'a', fact: 'fact A' }),
      makeResult({ id: 'b', fact: 'fact B' }),
    ];
    mockRAGStore.listMemories.mockReturnValue(results);
    mockRAGStore.deleteByIds.mockReturnValue(1);
    promptAnswer = '1';
    confirmAnswer = 'y';

    await factsList();

    expect(mockRAGStore.deleteByIds).toHaveBeenCalledWith(['a']);
    expect(infoMessages().some((m) => m.includes('Deleted 1 fact(s)'))).toBe(true);
  });

  it('handles cancel (empty input)', async () => {
    mockRAGStore.listMemories.mockReturnValue([makeResult()]);
    promptAnswer = '';

    await factsList();

    expect(mockRAGStore.deleteByIds).not.toHaveBeenCalled();
  });

  it('handles cancel on confirmation', async () => {
    mockRAGStore.listMemories.mockReturnValue([makeResult()]);
    promptAnswer = '1';
    confirmAnswer = 'n';

    await factsList();

    expect(mockRAGStore.deleteByIds).not.toHaveBeenCalled();
    expect(infoMessages()).toContain('Cancelled.');
  });

  it('numbers across domains continuously', async () => {
    mockRAGStore.listMemories.mockReturnValue([
      makeResult({ id: 'a', domain: 'tool-usage', fact: 'fact one' }),
      makeResult({ id: 'b', domain: 'tool-usage', fact: 'fact two' }),
      makeResult({ id: 'c', domain: 'general', fact: 'fact three' }),
    ]);

    await factsList();

    const msgs = infoMessages();
    expect(msgs.some((m) => m.includes('1.') && m.includes('fact one'))).toBe(true);
    expect(msgs.some((m) => m.includes('2.') && m.includes('fact two'))).toBe(true);
    expect(msgs.some((m) => m.includes('3.') && m.includes('fact three'))).toBe(true);
  });
});

describe('factsSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.loadConfig.mockReturnValue({ ragEnabled: true });
    mockRAGStore.searchWithIds.mockResolvedValue([]);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    promptAnswer = '';
    confirmAnswer = 'y';
  });

  it('shows message when RAG is disabled', async () => {
    mockConfig.loadConfig.mockReturnValue({ ragEnabled: false });
    await factsSearch('test query');
    expect(infoMessages().some((m) => m.includes('RAG is disabled'))).toBe(true);
  });

  it('shows message when no results found', async () => {
    await factsSearch('nonexistent topic');
    expect(infoMessages()).toContain('No matching facts found.');
  });

  it('displays results with similarity percentages', async () => {
    mockRAGStore.searchWithIds.mockResolvedValue([
      makeResult({ similarity: 0.92, fact: 'npm run build compiles TypeScript' }),
      makeResult({
        id: 'b',
        similarity: 0.78,
        domain: 'user-preferences',
        fact: 'prefers dark mode',
      }),
    ]);

    await factsSearch('build tools');

    const msgs = infoMessages();
    expect(msgs.some((m) => m.includes('2 results'))).toBe(true);
    expect(msgs.some((m) => m.includes('92%') && m.includes('npm run build'))).toBe(true);
    expect(msgs.some((m) => m.includes('78%') && m.includes('prefers dark mode'))).toBe(true);
  });

  it('detects file path and uses file contents as query', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as any);
    vi.mocked(fs.readFileSync).mockReturnValue('file content here');

    await factsSearch('./README.md');

    expect(mockRAGStore.searchWithIds).toHaveBeenCalledWith('file content here');
    expect(infoMessages().some((m) => m.includes('Using contents of'))).toBe(true);
  });

  it('falls through to text query when path is not a file', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await factsSearch('dark mode');

    expect(mockRAGStore.searchWithIds).toHaveBeenCalledWith('dark mode');
  });

  it('handles deletion flow with search results', async () => {
    mockRAGStore.searchWithIds.mockResolvedValue([makeResult({ id: 'x', fact: 'some fact' })]);
    mockRAGStore.deleteByIds.mockReturnValue(1);
    promptAnswer = '1';
    confirmAnswer = 'y';

    await factsSearch('some query');

    expect(mockRAGStore.deleteByIds).toHaveBeenCalledWith(['x']);
  });
});

describe('clearFacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.loadConfig.mockReturnValue({ ragEnabled: true });
    mockRAGStore.count.mockReturnValue(0);
    mockRAGStore.countByDomain.mockReturnValue({});
    clearConfirmAnswer = '';
  });

  it('shows message when RAG is disabled', async () => {
    mockConfig.loadConfig.mockReturnValue({ ragEnabled: false });
    await clearFacts();
    expect(infoMessages().some((m) => m.includes('RAG is disabled'))).toBe(true);
    expect(mockRAGStore.clear).not.toHaveBeenCalled();
  });

  it('shows message when no facts stored', async () => {
    mockRAGStore.count.mockReturnValue(0);
    await clearFacts();
    expect(infoMessages()).toContain('No facts stored. Nothing to clear.');
    expect(mockRAGStore.clear).not.toHaveBeenCalled();
  });

  it('shows per-domain breakdown before confirming', async () => {
    mockRAGStore.count.mockReturnValue(15);
    mockRAGStore.countByDomain.mockReturnValue({
      'tool-usage': 10,
      'user-preferences': 5,
    });
    clearConfirmAnswer = 'no';

    await clearFacts();

    const msgs = infoMessages();
    expect(msgs.some((m) => m.includes('tool-usage') && m.includes('10'))).toBe(true);
    expect(msgs.some((m) => m.includes('user-preferences') && m.includes('5'))).toBe(true);
    expect(msgs.some((m) => m.includes('Total:') && m.includes('15'))).toBe(true);
  });

  it('cancels when user types wrong confirmation', async () => {
    mockRAGStore.count.mockReturnValue(5);
    mockRAGStore.countByDomain.mockReturnValue({ general: 5 });
    clearConfirmAnswer = 'yes';

    await clearFacts();

    expect(infoMessages()).toContain('Cancelled.');
    expect(mockRAGStore.clear).not.toHaveBeenCalled();
  });

  it('cancels on empty input', async () => {
    mockRAGStore.count.mockReturnValue(5);
    mockRAGStore.countByDomain.mockReturnValue({ general: 5 });
    clearConfirmAnswer = '';

    await clearFacts();

    expect(infoMessages()).toContain('Cancelled.');
    expect(mockRAGStore.clear).not.toHaveBeenCalled();
  });

  it('clears all facts when user types exact confirmation phrase', async () => {
    mockRAGStore.count.mockReturnValue(15);
    mockRAGStore.countByDomain.mockReturnValue({
      'tool-usage': 10,
      'user-preferences': 5,
    });
    clearConfirmAnswer = 'yes, delete all facts';

    await clearFacts();

    expect(mockRAGStore.clear).toHaveBeenCalledOnce();
    const msgs = infoMessages();
    expect(msgs.some((m) => m.includes('Deleted 15 facts'))).toBe(true);
    expect(msgs.some((m) => m.includes('10 tool-usage'))).toBe(true);
    expect(msgs.some((m) => m.includes('5 user-preferences'))).toBe(true);
    expect(msgs.some((m) => m.includes('RAG memory is now empty'))).toBe(true);
  });
});
