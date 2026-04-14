import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CorrectionCandidateStore, MAX_PENDING_CORRECTIONS } from './correction-candidates.js';
import type { CorrectionCandidate } from './correction-candidates.js';

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

vi.mock('./fs-utils.js', () => ({
  atomicWriteFileSync: vi.fn(),
}));

const fs = await import('node:fs');
const fsUtils = await import('./fs-utils.js');

function makeCandidate(overrides: Partial<CorrectionCandidate> = {}): CorrectionCandidate {
  return {
    id: 'test-uuid-1234',
    specialistId: 'shell-wrapper',
    input: 'run ls',
    attemptedCall: JSON.stringify({ tool: 'shell', args: { command: 'ls' } }),
    error: 'command failed',
    createdAt: '2024-01-15T00:00:00.000Z',
    validated: false,
    status: 'pending',
    ...overrides,
  };
}

describe('CorrectionCandidateStore', () => {
  let store: CorrectionCandidateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    store = new CorrectionCandidateStore();
  });

  it('constructor creates directory', () => {
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('correction-candidates'),
      { recursive: true },
    );
  });

  describe('list', () => {
    it('returns empty array when no files exist', () => {
      expect(store.list()).toEqual([]);
    });

    it('parses and returns candidates sorted newest-first', () => {
      const older = makeCandidate({ id: 'old', createdAt: '2024-01-01T00:00:00.000Z' });
      const newer = makeCandidate({ id: 'new', createdAt: '2024-02-01T00:00:00.000Z' });
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

    it('skips corrupt files silently', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['good.json', 'bad.json'] as any);
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(JSON.stringify(makeCandidate()))
        .mockReturnValueOnce('not valid json {{{');
      const result = store.list();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('test-uuid-1234');
    });

    it('only processes .json files', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['a.json', 'b.txt', 'c.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(makeCandidate()));
      store.list();
      // readFileSync should only be called for the two .json files
      expect(fs.readFileSync).toHaveBeenCalledTimes(2);
    });
  });

  describe('listPending', () => {
    it('returns only candidates with status === pending', () => {
      const pending = makeCandidate({ id: 'p1', status: 'pending' });
      const applied = makeCandidate({ id: 'p2', status: 'applied' });
      const rejected = makeCandidate({ id: 'p3', status: 'rejected' });
      const invalid = makeCandidate({ id: 'p4', status: 'invalid' });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(
        ['p1.json', 'p2.json', 'p3.json', 'p4.json'] as any,
      );
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(JSON.stringify(pending))
        .mockReturnValueOnce(JSON.stringify(applied))
        .mockReturnValueOnce(JSON.stringify(rejected))
        .mockReturnValueOnce(JSON.stringify(invalid));
      const result = store.listPending();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('p1');
    });

    it('returns empty array when no pending candidates', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['a.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify(makeCandidate({ status: 'applied' })),
      );
      expect(store.listPending()).toEqual([]);
    });
  });

  describe('get', () => {
    it('returns candidate by id', () => {
      const candidate = makeCandidate();
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(candidate));
      const result = store.get('test-uuid-1234');
      expect(result).toEqual(candidate);
    });

    it('returns undefined for a missing file', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('returns undefined for a corrupt file', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('not json{{{');
      expect(store.get('corrupt')).toBeUndefined();
    });
  });

  describe('enqueue', () => {
    const input = {
      specialistId: 'shell-wrapper',
      input: 'run ls -la',
      attemptedCall: '{"tool":"shell","args":{"command":"ls -la"}}',
      error: 'exit code 1',
    };

    it('creates candidate with UUID and pending status', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      const candidate = store.enqueue(input);
      expect(candidate).toBeDefined();
      expect(candidate!.id).toBe('test-uuid-1234');
      expect(candidate!.status).toBe('pending');
      expect(candidate!.validated).toBe(false);
    });

    it('populates all fields from input', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      const candidate = store.enqueue(input);
      expect(candidate!.specialistId).toBe(input.specialistId);
      expect(candidate!.input).toBe(input.input);
      expect(candidate!.attemptedCall).toBe(input.attemptedCall);
      expect(candidate!.error).toBe(input.error);
    });

    it('sets a createdAt ISO timestamp', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      const candidate = store.enqueue(input);
      expect(candidate!.createdAt).toBeTruthy();
      expect(() => new Date(candidate!.createdAt)).not.toThrow();
    });

    it('writes the candidate via atomicWriteFileSync', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      store.enqueue(input);
      expect(fsUtils.atomicWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('test-uuid-1234.json'),
        expect.stringContaining('"status": "pending"'),
      );
    });

    it('returns undefined when at MAX_PENDING_CORRECTIONS', () => {
      const files = Array.from({ length: MAX_PENDING_CORRECTIONS }, (_, i) => `c${i}.json`);
      vi.mocked(fs.readdirSync).mockReturnValue(files as any);
      expect(store.enqueue(input)).toBeUndefined();
    });

    it('does not write when at MAX_PENDING_CORRECTIONS', () => {
      const files = Array.from({ length: MAX_PENDING_CORRECTIONS }, (_, i) => `c${i}.json`);
      vi.mocked(fs.readdirSync).mockReturnValue(files as any);
      store.enqueue(input);
      expect(fsUtils.atomicWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('merges patch into existing candidate and returns result', () => {
      const existing = makeCandidate({ id: 'abc', status: 'pending' });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existing));
      const result = store.update('abc', { status: 'applied', notes: 'fixed it' });
      expect(result).toBeDefined();
      expect(result!.status).toBe('applied');
      expect(result!.notes).toBe('fixed it');
    });

    it('preserves the original id regardless of patch content', () => {
      const existing = makeCandidate({ id: 'original-id' });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existing));
      const result = store.update('original-id', { id: 'attempted-override' } as any);
      expect(result!.id).toBe('original-id');
    });

    it('writes via atomicWriteFileSync', () => {
      const existing = makeCandidate({ id: 'abc' });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existing));
      store.update('abc', { status: 'applied' });
      expect(fsUtils.atomicWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('abc.json'),
        expect.any(String),
      );
    });

    it('returns undefined for a missing id', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(store.update('missing', { status: 'applied' })).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('calls unlinkSync with the correct path and returns true', () => {
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
      expect(store.delete('test-uuid-1234')).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('test-uuid-1234.json'),
      );
    });

    it('returns false when unlinkSync throws (file missing)', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(store.delete('nonexistent')).toBe(false);
    });
  });
});
