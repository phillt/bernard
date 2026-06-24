import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock dependencies before importing anything that uses them
const mockExtractDomainFacts = vi.fn();
const mockLoadConfig = vi.fn();
const mockAddFacts = vi.fn();
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

vi.mock('./rag.js', () => ({
  RAGStore: vi.fn().mockImplementation(() => ({
    addFacts: mockAddFacts,
  })),
}));

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
