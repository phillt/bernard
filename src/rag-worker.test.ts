import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock dependencies before importing anything that uses them
const mockExtractDomainFacts = vi.fn();
const mockLoadConfig = vi.fn();
const mockAddFacts = vi.fn();
const mockCleanupStaleTemp = vi.fn();
const mockDetectSpecialistCandidate = vi.fn();
const mockCandidateListPending = vi.fn(() => []);
const mockCandidateCreate = vi.fn();
const mockSpecialistList = vi.fn(() => []);

vi.mock('./config.js', () => ({
  loadConfig: (...args: any[]) => mockLoadConfig(...args),
}));

vi.mock('./context.js', () => ({
  extractDomainFacts: (...args: any[]) => mockExtractDomainFacts(...args),
}));

vi.mock('./rag.js', () => {
  const RAGStore = vi.fn().mockImplementation(() => ({ addFacts: mockAddFacts }));
  // Static, and the worker calls it without constructing a store — that is the
  // whole point of the call (a RAG-off session never builds one).
  // Wrapped rather than assigned directly: `vi.mock` factories are hoisted and
  // their BODY runs before the outer consts initialize, so referencing the spy
  // here eagerly throws. The sibling mocks get away with a bare reference only
  // because theirs sit inside a deferred arrow.
  (RAGStore as unknown as { cleanupStaleTemp: unknown }).cleanupStaleTemp = (...a: unknown[]) =>
    mockCleanupStaleTemp(...a);
  return { RAGStore };
});

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
}));

vi.mock('./specialist-candidates.js', () => ({
  CandidateStore: vi.fn().mockImplementation(() => ({
    listPending: mockCandidateListPending,
    create: mockCandidateCreate,
  })),
  MAX_PENDING_CANDIDATES: 10,
}));

vi.mock('./specialists.js', () => ({
  SpecialistStore: vi.fn().mockImplementation(() => ({
    // The real worker calls .list() — not .getSummaries() (which was an old drift).
    list: mockSpecialistList,
  })),
}));

vi.mock('./specialist-detector.js', () => ({
  detectSpecialistCandidate: (...args: any[]) => mockDetectSpecialistCandidate(...args),
}));

const mockConsolidationInputs = vi.fn(() => [] as Array<{ key: string; writtenAt?: string }>);
const mockProposeConsolidation = vi.fn(async () => [] as unknown[]);
const mockMemoryCandidateList = vi.fn(() => [] as unknown[]);
const mockMemoryCandidateListPending = vi.fn(() => [] as unknown[]);
const mockMemoryCandidateCreate = vi.fn();

vi.mock('./memory.js', () => ({
  MemoryStore: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('./memory-consolidation.js', () => ({
  consolidationInputs: (...a: any[]) => mockConsolidationInputs(...(a as [])),
  proposeConsolidation: (...a: any[]) => mockProposeConsolidation(...(a as [])),
}));

vi.mock('./memory-candidates.js', () => ({
  MemoryCandidateStore: vi.fn().mockImplementation(() => ({
    list: mockMemoryCandidateList,
    listPending: mockMemoryCandidateListPending,
    create: mockMemoryCandidateCreate,
  })),
  MAX_PENDING_MEMORY_CANDIDATES: 10,
  isSuppressed: () => false,
}));

// Import after mocks are wired.
import { runWorkerForFile } from './rag-worker.js';

describe('rag-worker (runWorkerForFile)', () => {
  let tempDir: string;
  let tempFile: string;

  const fakeConfig = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    ragEnabled: true,
    anthropicApiKey: 'sk-test',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-worker-test-'));
    tempFile = path.join(tempDir, '.pending-test.json');
    mockLoadConfig.mockReturnValue(fakeConfig);
    mockExtractDomainFacts.mockResolvedValue([
      { domain: 'tool-usage', facts: ['npm run build compiles project'] },
      { domain: 'user-preferences', facts: ['User prefers dark mode'] },
      { domain: 'general', facts: ['Project uses TypeScript'] },
    ]);
    mockAddFacts.mockResolvedValue(1);
  });

  afterEach(() => {
    // Clean up temp dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('memory consolidation arm (#529)', () => {
    const write = (payload: Record<string, unknown>) =>
      fs.writeFileSync(tempFile, JSON.stringify(payload));

    it('runs with no transcript at all — its gate is memory, not RAG', async () => {
      // The whole reason the spawn condition had to widen: `ragStore` is
      // undefined unless `config.ragEnabled`, and memory has nothing to do
      // with that setting.
      mockConsolidationInputs.mockReturnValue([{ key: 'a', writtenAt: new Date().toISOString() }]);
      write({ provider: 'anthropic', model: 'm', consolidateMemory: true });

      await runWorkerForFile(tempFile);

      expect(mockExtractDomainFacts).not.toHaveBeenCalled();
      expect(mockProposeConsolidation).toHaveBeenCalledTimes(1);
    });

    it('does not run when the payload does not ask for it', async () => {
      write({ serialized: 'x', provider: 'anthropic', model: 'm' });
      await runWorkerForFile(tempFile);
      expect(mockProposeConsolidation).not.toHaveBeenCalled();
    });

    it('queues a proposal rather than writing a memory', async () => {
      // The invariant the two sibling arms already keep: the worker only ever
      // enqueues. Nothing here touches the user's notes.
      const proposal = { kind: 'stale', keys: ['one-off'], reason: 'r' };
      mockConsolidationInputs.mockReturnValue([
        { key: 'one-off', writtenAt: '2020-01-01T00:00:00.000Z' },
      ]);
      mockProposeConsolidation.mockResolvedValue([proposal]);
      write({ provider: 'anthropic', model: 'm', consolidateMemory: true });

      await runWorkerForFile(tempFile);

      expect(mockMemoryCandidateCreate).toHaveBeenCalledWith(proposal, 'exit');
    });

    it('withholds records written since the last pass, rather than skipping the run', async () => {
      // "Too fresh to judge" — proposing to retire something written this
      // session is the fastest way to make a user turn this off.
      const { MEMORY_CONSOLIDATED_MARKER } = await import('./paths.js');
      fs.mkdirSync(path.dirname(MEMORY_CONSOLIDATED_MARKER), { recursive: true });
      fs.writeFileSync(MEMORY_CONSOLIDATED_MARKER, '2024-01-01T00:00:00.000Z\n');
      mockConsolidationInputs.mockReturnValue([
        { key: 'old', writtenAt: '2023-06-01T00:00:00.000Z' },
        { key: 'fresh', writtenAt: new Date().toISOString() },
      ]);
      write({ provider: 'anthropic', model: 'm', consolidateMemory: true });

      await runWorkerForFile(tempFile);

      const entries = mockProposeConsolidation.mock.calls[0][0] as Array<{ key: string }>;
      expect(entries.map((e) => e.key)).toEqual(['old']);
      fs.rmSync(MEMORY_CONSOLIDATED_MARKER, { force: true });
    });

    it('calls no model when nothing changed since the last pass', async () => {
      const { MEMORY_CONSOLIDATED_MARKER } = await import('./paths.js');
      fs.mkdirSync(path.dirname(MEMORY_CONSOLIDATED_MARKER), { recursive: true });
      fs.writeFileSync(MEMORY_CONSOLIDATED_MARKER, new Date().toISOString() + '\n');
      mockConsolidationInputs.mockReturnValue([
        { key: 'old', writtenAt: '2023-06-01T00:00:00.000Z' },
      ]);
      write({ provider: 'anthropic', model: 'm', consolidateMemory: true });

      await runWorkerForFile(tempFile);

      expect(mockProposeConsolidation).not.toHaveBeenCalled();
      fs.rmSync(MEMORY_CONSOLIDATED_MARKER, { force: true });
    });

    it('examines a record on the run AFTER the one that withheld it as too fresh', async () => {
      // The defect this shape exists to prevent, and nothing else catches it
      // because no other test runs the pass twice.
      //
      // With the marker storing the RUN TIME, the trigger set and the input set
      // were exact complements: a record written this session made `changed`
      // true and was then withheld as too fresh, the marker advanced past it,
      // and the next quiet session found `changed` false and returned before
      // looking. A user's most recent memory was never examined at all.
      const { MEMORY_CONSOLIDATED_MARKER } = await import('./paths.js');
      fs.mkdirSync(path.dirname(MEMORY_CONSOLIDATED_MARKER), { recursive: true });
      fs.rmSync(MEMORY_CONSOLIDATED_MARKER, { force: true });

      const HOUR = 60 * 60 * 1000;
      const justWritten = new Date(Date.now() - HOUR).toISOString();
      mockConsolidationInputs.mockReturnValue([{ key: 'recent', writtenAt: justWritten }]);
      write({ provider: 'anthropic', model: 'm', consolidateMemory: true });

      // Run 1: too fresh to judge, so nothing is proposed about it — correct.
      await runWorkerForFile(tempFile);
      expect(mockProposeConsolidation.mock.calls[0][0]).toEqual([]);

      // Run 2, days later, no new writes. The record is now old enough, and the
      // gate must still fire — under the old shape it did not.
      const later = Date.now() + 3 * 24 * HOUR;
      vi.spyOn(Date, 'now').mockReturnValue(later);
      try {
        write({ provider: 'anthropic', model: 'm', consolidateMemory: true });
        await runWorkerForFile(tempFile);
        expect(mockProposeConsolidation).toHaveBeenCalledTimes(2);
        const seen = mockProposeConsolidation.mock.calls[1][0] as Array<{ key: string }>;
        expect(seen.map((e) => e.key)).toEqual(['recent']);
      } finally {
        vi.mocked(Date.now).mockRestore();
        fs.rmSync(MEMORY_CONSOLIDATED_MARKER, { force: true });
      }
    });

    it('reaps orphaned payloads even when RAG never ran', async () => {
      // `RAGStore.cleanupStaleTemp` was only reachable through that store's
      // CONSTRUCTOR, which a RAG-off session never runs — and this change is
      // what made those sessions write payloads into RAG_DIR in the first place.
      write({ provider: 'anthropic', model: 'm', consolidateMemory: true });
      await runWorkerForFile(tempFile);
      expect(mockCleanupStaleTemp).toHaveBeenCalled();
    });

    it('does not cost fact extraction its result when it throws', async () => {
      // `allSettled`, not `all` — the reason the sibling arms are shaped this
      // way, checked for the third.
      mockConsolidationInputs.mockImplementation(() => {
        throw new Error('boom');
      });
      write({ serialized: 'x', provider: 'anthropic', model: 'm', consolidateMemory: true });

      await runWorkerForFile(tempFile);

      expect(mockExtractDomainFacts).toHaveBeenCalled();
      expect(mockAddFacts).toHaveBeenCalled();
      expect(fs.existsSync(tempFile)).toBe(false);
      mockConsolidationInputs.mockReset();
      mockConsolidationInputs.mockReturnValue([]);
    });
  });

  it('reads temp file, extracts domain facts, stores per-domain, and deletes temp file', async () => {
    const payload = {
      serialized: 'User: I prefer dark mode\nAssistant: Noted!',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
    };
    fs.writeFileSync(tempFile, JSON.stringify(payload));

    await runWorkerForFile(tempFile);

    expect(mockLoadConfig).toHaveBeenCalledWith({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
    });
    // Now called with (serialized, config, undefined, AbortSignal) — check the key args
    expect(mockExtractDomainFacts).toHaveBeenCalledWith(
      payload.serialized,
      fakeConfig,
      undefined,
      expect.any(AbortSignal),
    );

    // Should store facts per domain
    expect(mockAddFacts).toHaveBeenCalledWith(
      ['npm run build compiles project'],
      'exit',
      'tool-usage',
    );
    expect(mockAddFacts).toHaveBeenCalledWith(
      ['User prefers dark mode'],
      'exit',
      'user-preferences',
    );
    expect(mockAddFacts).toHaveBeenCalledWith(['Project uses TypeScript'], 'exit', 'general');
    expect(mockAddFacts).toHaveBeenCalledTimes(3);

    expect(fs.existsSync(tempFile)).toBe(false);
  });

  it('does not create RAGStore when no facts are extracted', async () => {
    mockExtractDomainFacts.mockResolvedValue([]);
    const { RAGStore } = await import('./rag.js');

    const payload = {
      serialized: 'User: hello\nAssistant: hi',
      provider: 'openai',
      model: 'gpt-4o-mini',
    };
    fs.writeFileSync(tempFile, JSON.stringify(payload));

    await runWorkerForFile(tempFile);

    expect(mockExtractDomainFacts).toHaveBeenCalled();
    expect(RAGStore).not.toHaveBeenCalled();
    expect(fs.existsSync(tempFile)).toBe(false);
  });

  it('passes provider and model overrides to loadConfig', async () => {
    const payload = {
      serialized: 'User: test\nAssistant: ok',
      provider: 'openai',
      model: 'gpt-4o-mini',
    };
    fs.writeFileSync(tempFile, JSON.stringify(payload));

    await runWorkerForFile(tempFile);

    expect(mockLoadConfig).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('handles partial domain extraction (only some domains have facts)', async () => {
    mockExtractDomainFacts.mockResolvedValue([
      { domain: 'general', facts: ['Project uses TypeScript'] },
    ]);

    const payload = {
      serialized: 'User: test\nAssistant: ok',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
    };
    fs.writeFileSync(tempFile, JSON.stringify(payload));

    await runWorkerForFile(tempFile);

    expect(mockAddFacts).toHaveBeenCalledTimes(1);
    expect(mockAddFacts).toHaveBeenCalledWith(['Project uses TypeScript'], 'exit', 'general');
  });

  it('returns early without crashing on a missing temp file', async () => {
    await expect(runWorkerForFile('/nonexistent/path.json')).resolves.toBeUndefined();
  });

  it('deletes temp file and returns early when payload fields are missing', async () => {
    const payload = { serialized: '', provider: 'anthropic' }; // missing model
    fs.writeFileSync(tempFile, JSON.stringify(payload));

    await runWorkerForFile(tempFile);

    expect(mockExtractDomainFacts).not.toHaveBeenCalled();
    expect(fs.existsSync(tempFile)).toBe(false);
  });

  describe('specialist candidate detection', () => {
    const makePayload = () => ({
      serialized: 'User: review my code\nAssistant: Sure!',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
    });

    const fakeDetectorResult = {
      type: 'new-candidate' as const,
      candidate: {
        draftId: 'code-review',
        name: 'Code Review',
        description: 'Reviews pull requests',
        systemPrompt: 'You are a code reviewer.',
        guidelines: [],
        confidence: 0.85,
        reasoning: 'Frequent code review requests',
      },
    };

    it('creates candidate when detection returns a new-candidate result', async () => {
      mockDetectSpecialistCandidate.mockResolvedValue(fakeDetectorResult);
      mockCandidateListPending.mockReturnValue([]);
      mockSpecialistList.mockReturnValue([]);

      const payload = makePayload();
      fs.writeFileSync(tempFile, JSON.stringify(payload));
      await runWorkerForFile(tempFile);

      expect(mockDetectSpecialistCandidate).toHaveBeenCalledWith(
        payload.serialized,
        fakeConfig,
        [],
        [],
      );
      expect(mockCandidateCreate).toHaveBeenCalledWith(fakeDetectorResult.candidate, 'exit');
    });

    it('does not create candidate when detection returns null', async () => {
      mockDetectSpecialistCandidate.mockResolvedValue(null);
      mockCandidateListPending.mockReturnValue([]);

      fs.writeFileSync(tempFile, JSON.stringify(makePayload()));
      await runWorkerForFile(tempFile);

      expect(mockDetectSpecialistCandidate).toHaveBeenCalled();
      expect(mockCandidateCreate).not.toHaveBeenCalled();
    });

    it('skips detection when max pending candidates reached', async () => {
      const tenCandidates = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}` }));
      mockCandidateListPending.mockReturnValue(tenCandidates);

      fs.writeFileSync(tempFile, JSON.stringify(makePayload()));
      await runWorkerForFile(tempFile);

      expect(mockDetectSpecialistCandidate).not.toHaveBeenCalled();
      expect(mockCandidateCreate).not.toHaveBeenCalled();
    });

    it('silently catches detection errors without affecting fact storage', async () => {
      mockDetectSpecialistCandidate.mockRejectedValue(new Error('LLM timeout'));
      mockCandidateListPending.mockReturnValue([]);

      fs.writeFileSync(tempFile, JSON.stringify(makePayload()));
      await runWorkerForFile(tempFile);

      // Facts should still have been stored
      expect(mockAddFacts).toHaveBeenCalledTimes(3);
      // Candidate should not have been created
      expect(mockCandidateCreate).not.toHaveBeenCalled();
      // Temp file should still be cleaned up
      expect(fs.existsSync(tempFile)).toBe(false);
    });

    it('calls specialistStore.list() (not getSummaries) to get existing specialists', async () => {
      const existingSpecialist = { id: 'shell-wrapper', name: 'Shell Wrapper' };
      mockSpecialistList.mockReturnValue([existingSpecialist]);
      mockDetectSpecialistCandidate.mockResolvedValue(null);
      mockCandidateListPending.mockReturnValue([]);

      fs.writeFileSync(tempFile, JSON.stringify(makePayload()));
      await runWorkerForFile(tempFile);

      // Verify .list() was called (not .getSummaries())
      expect(mockSpecialistList).toHaveBeenCalled();
      expect(mockDetectSpecialistCandidate).toHaveBeenCalledWith(
        expect.any(String),
        fakeConfig,
        [existingSpecialist],
        [],
      );
    });
  });
});
