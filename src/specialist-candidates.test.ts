import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidateStore, MAX_PENDING_CANDIDATES } from './specialist-candidates.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234'),
}));

const fs = await import('node:fs');

function makeDraft(overrides: Record<string, unknown> = {}) {
  return {
    draftId: 'code-review',
    name: 'Code Review Specialist',
    description: 'Reviews code for quality',
    systemPrompt: 'You are a code reviewer.',
    guidelines: ['Check for bugs'],
    confidence: 0.85,
    reasoning: 'User repeatedly asked for code reviews with specific rules.',
    ...overrides,
  };
}

function makeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-uuid-1234',
    draftId: 'code-review',
    name: 'Code Review Specialist',
    description: 'Reviews code for quality',
    systemPrompt: 'You are a code reviewer.',
    guidelines: ['Check for bugs'],
    confidence: 0.85,
    reasoning: 'User repeatedly asked for code reviews with specific rules.',
    detectedAt: '2024-01-15T00:00:00.000Z',
    source: 'exit',
    acknowledged: false,
    status: 'pending',
    ...overrides,
  };
}

describe('CandidateStore', () => {
  let store: CandidateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    store = new CandidateStore();
  });

  it('constructor creates directory', () => {
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('specialist-candidates'), {
      recursive: true,
    });
  });

  describe('list', () => {
    it('returns empty array when no files', () => {
      expect(store.list()).toEqual([]);
    });

    it('returns candidates sorted by detectedAt descending', () => {
      const older = makeCandidate({ id: 'old', detectedAt: '2024-01-01T00:00:00.000Z' });
      const newer = makeCandidate({ id: 'new', detectedAt: '2024-02-01T00:00:00.000Z' });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['old.json', 'new.json'] as any);
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(JSON.stringify(older))
        .mockReturnValueOnce(JSON.stringify(newer));
      const result = store.list();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('new');
      expect(result[1].id).toBe('old');
    });

    it('skips corrupt files', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['good.json', 'bad.json'] as any);
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(JSON.stringify(makeCandidate()))
        .mockReturnValueOnce('not json{{{');
      const result = store.list();
      expect(result).toHaveLength(1);
    });
  });

  describe('listPending', () => {
    it('only returns pending candidates', () => {
      const pending = makeCandidate({ id: 'p1', status: 'pending' });
      const accepted = makeCandidate({ id: 'p2', status: 'accepted' });
      const rejected = makeCandidate({ id: 'p3', status: 'rejected' });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['p1.json', 'p2.json', 'p3.json'] as any);
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(JSON.stringify(pending))
        .mockReturnValueOnce(JSON.stringify(accepted))
        .mockReturnValueOnce(JSON.stringify(rejected));
      const result = store.listPending();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('p1');
    });
  });

  describe('reconcileSaved', () => {
    it('marks candidate matching by draftId as accepted', () => {
      const candidate = makeCandidate({ id: 'c1', draftId: 'code-review', name: 'Code Review' });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['c1.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(candidate));

      const count = store.reconcileSaved([{ id: 'code-review', name: 'Code Review Specialist' }]);
      expect(count).toBe(1);
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const written = JSON.parse(writeCall[1] as string);
      expect(written.status).toBe('accepted');
    });

    it('marks candidate matching by name (case-insensitive) as accepted', () => {
      const candidate = makeCandidate({ id: 'c1', draftId: 'different-id', name: 'Code Review' });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['c1.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(candidate));

      const count = store.reconcileSaved([{ id: 'unrelated', name: 'code review' }]);
      expect(count).toBe(1);
    });

    it('does not mark non-matching candidates', () => {
      const candidate = makeCandidate({ id: 'c1', draftId: 'email-triage', name: 'Email Triage' });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['c1.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(candidate));

      const count = store.reconcileSaved([{ id: 'code-review', name: 'Code Review' }]);
      expect(count).toBe(0);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('returns 0 when no saved specialists', () => {
      const candidate = makeCandidate({ id: 'c1' });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['c1.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(candidate));

      const count = store.reconcileSaved([]);
      expect(count).toBe(0);
    });
  });

  describe('get', () => {
    it('returns candidate by id', () => {
      const candidate = makeCandidate();
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(candidate));
      expect(store.get('test-uuid-1234')).toEqual(candidate);
    });

    it('returns undefined for missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.get('nope')).toBeUndefined();
    });

    it('returns undefined for corrupt file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not json{{{');
      expect(store.get('corrupt')).toBeUndefined();
    });
  });

  describe('create', () => {
    it('writes correct structure with UUID and timestamps', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      const candidate = store.create(makeDraft(), 'exit');
      expect(candidate.id).toBe('test-uuid-1234');
      expect(candidate.draftId).toBe('code-review');
      expect(candidate.name).toBe('Code Review Specialist');
      expect(candidate.status).toBe('pending');
      expect(candidate.acknowledged).toBe(false);
      expect(candidate.source).toBe('exit');
      expect(candidate.detectedAt).toBeTruthy();
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
    });

    it('defaults source to exit', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      const candidate = store.create(makeDraft());
      expect(candidate.source).toBe('exit');
    });

    it('throws at MAX_PENDING_CANDIDATES', () => {
      const files = Array.from({ length: MAX_PENDING_CANDIDATES }, (_, i) => `c${i}.json`);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(files as any);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify(makeCandidate({ status: 'pending' })),
      );
      expect(() => store.create(makeDraft())).toThrow('Maximum');
    });

    it('does not throw when max reached but non-pending', () => {
      const files = Array.from({ length: MAX_PENDING_CANDIDATES }, (_, i) => `c${i}.json`);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(files as any);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify(makeCandidate({ status: 'accepted' })),
      );
      expect(() => store.create(makeDraft())).not.toThrow();
    });
  });

  describe('acknowledge', () => {
    it('sets acknowledged to true', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify(makeCandidate({ acknowledged: false })),
      );
      expect(store.acknowledge('test-uuid-1234')).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
    });

    it('returns false for missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.acknowledge('nope')).toBe(false);
    });
  });

  describe('updateStatus', () => {
    it('updates status field', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(makeCandidate()));
      expect(store.updateStatus('test-uuid-1234', 'accepted')).toBe(true);
      // Verify the written data includes the new status
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const written = JSON.parse(writeCall[1] as string);
      expect(written.status).toBe('accepted');
    });

    it('returns false for missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.updateStatus('nope', 'rejected')).toBe(false);
    });
  });

  describe('delete', () => {
    it('removes file and returns true', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(store.delete('test-uuid-1234')).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('returns false for missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.delete('nope')).toBe(false);
    });
  });

  describe('pruneOld', () => {
    it('dismisses candidates older than 30 days', () => {
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const recentDate = new Date().toISOString();
      const old = makeCandidate({ id: 'old', detectedAt: oldDate, status: 'pending' });
      const recent = makeCandidate({ id: 'recent', detectedAt: recentDate, status: 'pending' });

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['old.json', 'recent.json'] as any);
      // list() reads all files, then pruneOld re-reads for updateStatus
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(JSON.stringify(old))
        .mockReturnValueOnce(JSON.stringify(recent))
        // updateStatus re-reads the old candidate
        .mockReturnValueOnce(JSON.stringify(old));

      const pruned = store.pruneOld();
      expect(pruned).toBe(1);
    });

    it('returns 0 when nothing to prune', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      expect(store.pruneOld()).toBe(0);
    });
  });
});
