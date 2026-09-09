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
  // `storageFile` derives from the `dir` it was constructed with, because that
  // is the property under test for `clear-facts`: it must name the store it is
  // about to destroy, not the main one.
  RAGStore: vi.fn((cfg?: { dir?: string }) => ({
    ...mockRAGStore,
    storageFile: `${cfg?.dir ?? '/main/rag'}/memories.json`,
  })),
}));

const mockSpecialistIds = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('./specialist-rag.js', async (orig) => ({
  // `specialistFactsNotice` comes from the real module over the mocked id list,
  // so the sentence under test is the one users see rather than a restatement.
  ...(await orig<Record<string, unknown>>()),
  listSpecialistRagIds: () => mockSpecialistIds.ids,
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
      // Distinguish between selection prompt, clear-facts confirm, and y/N confirm
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
import { RAGStore } from './rag.js';

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

/**
 * Each specialist has had its own store since #501, and these commands had no
 * flag at all — so the one command that answers "what have you learned?" could
 * see only the user's own store and said nothing about the others.
 */
describe('the --specialist flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.loadConfig.mockReturnValue({ ragEnabled: true });
    mockRAGStore.listMemories.mockReturnValue([]);
    mockRAGStore.count.mockReturnValue(0);
    mockRAGStore.countByDomain.mockReturnValue({});
    mockSpecialistIds.ids = [];
    promptAnswer = '';
    confirmAnswer = 'y';
  });

  function dirOfLastStore(): string | undefined {
    const last = vi.mocked(RAGStore).mock.calls.at(-1)?.[0] as { dir?: string } | undefined;
    return last?.dir;
  }

  it('opens the specialist store rather than the user`s', async () => {
    mockSpecialistIds.ids = ['coder'];
    await factsList('coder');
    expect(dirOfLastStore()).toContain('specialists');
    expect(dirOfLastStore()).toContain('coder');
  });

  it('opens the user`s store when no id is given', async () => {
    // Byte-identical to before: `new RAGStore()` with no argument.
    await factsList();
    expect(dirOfLastStore()).toBeUndefined();
  });

  it('refuses an unknown id and names the ones that exist', async () => {
    // Thrown rather than returned as a message: `index.ts` already wraps both
    // commands in a `try` that prints it, so the three hand-written narrowings
    // the first cut had bought nothing.
    mockSpecialistIds.ids = ['coder', 'designer'];
    await expect(factsList('typo')).rejects.toThrow(/coder, designer/);
    // Nothing was opened, so nothing could be deleted from the wrong store.
    expect(vi.mocked(RAGStore)).not.toHaveBeenCalled();
  });

  it('says so plainly when no specialist has learned anything yet', async () => {
    await expect(factsList('coder')).rejects.toThrow(/No specialist has its own facts yet/);
  });

  it('names the other stores on the user`s own listing', async () => {
    mockSpecialistIds.ids = ['coder', 'designer'];
    await factsList();
    expect(infoMessages().join('\n')).toContain('bernard facts --specialist <id>');
    expect(infoMessages().join('\n')).toContain('coder, designer');
  });

  it('names them after a SEARCH that found something, too', async () => {
    // The divergence the `string | null` footer had already produced: the search
    // path printed it only when there were zero results, so a user who searched
    // and got hits was never told the other stores existed.
    mockSpecialistIds.ids = ['coder'];
    mockRAGStore.searchWithIds.mockResolvedValue([
      { id: '1', fact: 'a fact', similarity: 0.9, domain: 'general' },
    ]);
    await factsSearch('anything');
    expect(infoMessages().join('\n')).toContain('bernard facts --specialist <id>');
  });

  it('prints nothing extra when there are no other stores', async () => {
    // Today's output, unchanged — which is every install until a specialist runs.
    await factsList();
    expect(infoMessages().join('\n')).not.toContain('--specialist');
  });

  it('does not advertise siblings inside a specialist`s own listing', async () => {
    mockSpecialistIds.ids = ['coder', 'designer'];
    await factsList('coder');
    expect(infoMessages().join('\n')).not.toContain('--specialist <id>');
  });

  it('clear-facts names the store it is about to destroy, not the main one', async () => {
    // The one screen whose whole job is to say what is about to go. It printed
    // the imported `MEMORIES_FILE` unconditionally, which became the wrong path
    // the moment a flag existed.
    mockSpecialistIds.ids = ['coder'];
    mockRAGStore.count.mockReturnValue(3);
    mockRAGStore.countByDomain.mockReturnValue({ general: 3 });
    clearConfirmAnswer = '';
    await clearFacts('coder');
    const storage = infoMessages().find((m) => m.includes('Storage:'));
    expect(storage).toContain('coder');
  });
});
