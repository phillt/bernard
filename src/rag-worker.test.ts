import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MEMORY_CONSOLIDATED_MARKER, SPECIALIST_RECALL_MARKER } from './paths.js';

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
  const RAGStore = vi.fn().mockImplementation(() => ({ addFacts: mockAddFacts, flush: vi.fn() }));
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
    get: (id: string) => mockSpecialistGet(id),
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
  MemoryStore: vi.fn().mockImplementation(() => ({ asOwner: mockAsOwner })),
}));

const mockExtractNotes = vi.fn(async () => [] as Array<{ key: string; content: string }>);
const mockWriteMemory = vi.fn();
const mockAsOwner = vi.fn(() => ({ writeMemory: mockWriteMemory }));
const mockReadJsonlTail = vi.fn(() => [] as unknown[]);
const mockSpecialistGet = vi.fn((id: string) => ({ id }) as unknown);

vi.mock('./specialist-recall.js', () => ({
  extractSpecialistNotes: (...a: any[]) => mockExtractNotes(...(a as [])),
}));

// The reasoning log's own reader, not `jsonl.js` beneath it: `readJsonlTail` is
// shared with `session-telemetry` and the script log, and mocking a module three
// unrelated readers go through is broader than this suite needs.
vi.mock('./reasoning-log.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readReasoningLog: (...a: any[]) => mockReadJsonlTail(...(a as [])),
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
    // Re-seeded, not merely cleared: `clearAllMocks` leaves the implementation,
    // so a sibling test's `mockReturnValue`/`mockResolvedValue` on these two is
    // what the next test sees. Under a shuffled order that decided whether the
    // consolidation arm had any input to propose on.
    mockConsolidationInputs.mockReset().mockReturnValue([]);
    mockProposeConsolidation.mockReset().mockResolvedValue([]);
    // On-disk state, not a mock: a successful consolidation pass WRITES this
    // marker, so a sibling test that ran the arm leaves a cutoff of `now`
    // behind and every later test's records are withheld as "nothing changed".
    // Owned here rather than by the two tests that seed it deliberately — a
    // trailing `rmSync` does not run when the assertion above it fails, which
    // is exactly when the leak matters.
    fs.rmSync(MEMORY_CONSOLIDATED_MARKER, { force: true });
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
    });

    it('calls no model when nothing changed since the last pass', async () => {
      fs.mkdirSync(path.dirname(MEMORY_CONSOLIDATED_MARKER), { recursive: true });
      fs.writeFileSync(MEMORY_CONSOLIDATED_MARKER, new Date().toISOString() + '\n');
      mockConsolidationInputs.mockReturnValue([
        { key: 'old', writtenAt: '2023-06-01T00:00:00.000Z' },
      ]);
      write({ provider: 'anthropic', model: 'm', consolidateMemory: true });

      await runWorkerForFile(tempFile);

      expect(mockProposeConsolidation).not.toHaveBeenCalled();
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
      fs.mkdirSync(path.dirname(MEMORY_CONSOLIDATED_MARKER), { recursive: true });

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
  describe('specialist recall arm (#501)', () => {
    const write = (payload: Record<string, unknown>) =>
      fs.writeFileSync(tempFile, JSON.stringify(payload));

    beforeEach(() => {
      // Re-seeded, not merely cleared: `clearAllMocks` leaves implementations
      // and `*Once` queues, so a sibling's `mockReturnValue` on these is what
      // the next test sees — the #457 class, and this block hit it immediately.
      mockReadJsonlTail.mockReset().mockReturnValue([]);
      mockExtractNotes.mockReset().mockResolvedValue([]);
      mockSpecialistGet.mockReset().mockImplementation((id: string) => ({ id }) as unknown);
      mockAsOwner.mockReset().mockReturnValue({ writeMemory: mockWriteMemory });
      mockWriteMemory.mockReset();
      // On-disk state, not a mock: a successful pass WRITES this marker, so a
      // sibling test leaves a cutoff of `now` behind and every later test's log
      // entries are filtered out as already-seen. Owned here rather than by the
      // one test that seeds it deliberately — a trailing `rmSync` does not run
      // when the assertion above it fails, which is exactly when it matters.
      fs.rmSync(SPECIALIST_RECALL_MARKER, { force: true });
    });

    const run = (specialistId: string, ts = new Date().toISOString()) => ({
      ts,
      specialistId,
      input: 'do the thing',
      toolCalls: [{ tool: 'shell', args: { command: 'ls' }, resultPreview: 'ok' }],
      finalOutput: 'x'.repeat(500),
      status: 'ok',
    });

    it('runs without a transcript and without RAG — its gate is the log', async () => {
      // The whole reason it is a third independent gate. Hanging it off
      // `serialized` or `ragEnabled` would make it silently never run for
      // settings that have nothing to do with what a specialist remembers.
      mockReadJsonlTail.mockReturnValue([run('coder')]);
      mockExtractNotes.mockResolvedValue([{ key: 'build-uses-pnpm', content: 'Use pnpm.' }]);
      write({ provider: 'anthropic', model: 'm', specialistRecall: true });

      await runWorkerForFile(tempFile);

      expect(mockExtractDomainFacts).not.toHaveBeenCalled();
      expect(mockExtractNotes).toHaveBeenCalledTimes(1);
    });

    it('writes the note as that specialist, not as the user', async () => {
      // The fence is the point: a note written unowned would land in the shared
      // pool the main agent reads, which is exactly what ownership prevents.
      mockReadJsonlTail.mockReturnValue([run('coder')]);
      mockExtractNotes.mockResolvedValue([{ key: 'build-uses-pnpm', content: 'Use pnpm.' }]);
      write({ provider: 'anthropic', model: 'm', specialistRecall: true });

      await runWorkerForFile(tempFile);

      expect(mockAsOwner).toHaveBeenCalledWith('coder');
      expect(mockWriteMemory).toHaveBeenCalledWith('build-uses-pnpm', 'Use pnpm.');
    });

    it('extracts ONCE per specialist, not once per dispatch', async () => {
      // The cost decision: `extractDomainFacts` fans out four calls per
      // transcript, and four specialists in a session would be sixteen. Grouping
      // also means a specialist that ran five times gets one extraction that can
      // see all five rather than five that cannot see each other.
      mockReadJsonlTail.mockReturnValue([run('coder'), run('coder'), run('designer')]);
      mockExtractNotes.mockResolvedValue([]);
      write({ provider: 'anthropic', model: 'm', specialistRecall: true });

      await runWorkerForFile(tempFile);

      expect(mockExtractNotes).toHaveBeenCalledTimes(2);
      expect(mockExtractNotes.mock.calls.map((c: any[]) => c[0]).sort()).toEqual([
        'coder',
        'designer',
      ]);
    });

    it('skips a specialist that no longer exists', async () => {
      // Its notes would be owned by an id nothing resolves — unreadable the
      // moment they land, and swept by nothing, because the sweep already ran.
      mockReadJsonlTail.mockReturnValue([run('deleted-one')]);
      mockSpecialistGet.mockReturnValue(undefined as never);
      write({ provider: 'anthropic', model: 'm', specialistRecall: true });

      await runWorkerForFile(tempFile);

      expect(mockExtractNotes).not.toHaveBeenCalled();
      expect(mockWriteMemory).not.toHaveBeenCalled();
    });

    it("also seeds the specialist's own RAG store, which nothing else fills", async () => {
      // The producer gap: a store per specialist is an EMPTY store until
      // something writes into it, and the three existing RAG producers all read
      // the MAIN transcript. This is the one that fills it.
      mockReadJsonlTail.mockReturnValue([run('coder')]);
      mockExtractNotes.mockResolvedValue([{ key: 'k', content: 'Use pnpm.' }]);
      write({ provider: 'anthropic', model: 'm', specialistRecall: true });

      await runWorkerForFile(tempFile);

      expect(mockAddFacts).toHaveBeenCalledWith(['Use pnpm.'], 'exit');
    });

    it('writes no facts when there is nothing durable to remember', async () => {
      // Guards the guard: the common case is no notes, and an unconditional
      // write would construct a store — and a directory — for every specialist
      // that ran, whether or not it learned anything.
      mockReadJsonlTail.mockReturnValue([run('coder')]);
      mockExtractNotes.mockResolvedValue([]);
      write({ provider: 'anthropic', model: 'm', specialistRecall: true });

      await runWorkerForFile(tempFile);

      expect(mockAddFacts).not.toHaveBeenCalled();
    });

    it('does not run when the payload does not ask for it', async () => {
      mockReadJsonlTail.mockReturnValue([run('coder')]);
      write({ serialized: 'x', provider: 'anthropic', model: 'm' });
      await runWorkerForFile(tempFile);
      expect(mockExtractNotes).not.toHaveBeenCalled();
    });

    it('examines only what happened since the last pass', async () => {
      // The marker stores the inclusion CUTOFF, not the run time — the shape #529
      // had to correct once, because storing the run time makes the trigger set
      // and the input set exact complements.
      fs.mkdirSync(path.dirname(SPECIALIST_RECALL_MARKER), { recursive: true });
      fs.writeFileSync(SPECIALIST_RECALL_MARKER, new Date(Date.now() - 1000).toISOString() + '\n');
      mockReadJsonlTail.mockReturnValue([run('old', '2020-01-01T00:00:00.000Z')]);
      write({ provider: 'anthropic', model: 'm', specialistRecall: true });

      await runWorkerForFile(tempFile);

      expect(mockExtractNotes).not.toHaveBeenCalled();
      fs.rmSync(SPECIALIST_RECALL_MARKER, { force: true });
    });

    it('feeds the model the NEWEST runs, and stops at the budget', async () => {
      // Two defects in one line. `runs.map(render).join().slice(0, MAX)` built
      // 825 KB to keep 75 KB on a real log — the bound-during-construction rule
      // #347 already states — and, worse, the log is oldest-first, so the front
      // slice fed the model the OLDEST 7 of `shell-wrapper`'s 265 runs and
      // discarded the 258 most recent. What a specialist did last is the part
      // worth learning from.
      const many = Array.from({ length: 60 }, (_, i) =>
        Object.assign(run('coder'), { input: `run-${i}` }),
      );
      mockReadJsonlTail.mockReturnValue(many);
      write({ provider: 'anthropic', model: 'm', specialistRecall: true });

      await runWorkerForFile(tempFile);

      const transcript = mockExtractNotes.mock.calls[0][1] as string;
      expect(transcript).toContain('run-59');
      expect(transcript).not.toContain('run-0\n');
      expect(transcript.length).toBeLessThanOrEqual(12_000);
    });

    it('runs the specialists in parallel rather than one after another', async () => {
      // The arm otherwise decides how long the detached worker lives: cheap-tier
      // latency is p50 4.7 s, so four specialists cost 19 s in sequence and one
      // round trip fanned out — the shape `extractDomainFacts` already uses.
      let live = 0;
      let peak = 0;
      mockExtractNotes.mockImplementation(async () => {
        peak = Math.max(peak, ++live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return [];
      });
      mockReadJsonlTail.mockReturnValue([run('a'), run('b'), run('c')]);
      write({ provider: 'anthropic', model: 'm', specialistRecall: true });

      await runWorkerForFile(tempFile);

      expect(peak).toBe(3);
    });

    it('one specialist failing does not cost the others their notes', async () => {
      // `Promise.allSettled`, not `Promise.all`: a rejected extraction must not
      // discard work the siblings already did, in a detached process nobody is
      // watching.
      mockExtractNotes.mockImplementation(async (id: string) =>
        id === 'a' ? Promise.reject(new Error('boom')) : [{ key: 'k', content: 'c' }],
      );
      mockReadJsonlTail.mockReturnValue([run('a'), run('b')]);
      write({ provider: 'anthropic', model: 'm', specialistRecall: true });

      await runWorkerForFile(tempFile);

      expect(mockWriteMemory).toHaveBeenCalledWith('k', 'c');
    });
  });
});

/**
 * Specialist recall (#501) — the arm that WRITES.
 *
 * The main agent has had a closing pass since this worker existed; a specialist
 * got nothing, because its dispatch transcript was discarded. This reads the
 * reasoning log — which every dispatch now writes — so it needs neither a
 * transcript in the payload nor RAG enabled.
 */
