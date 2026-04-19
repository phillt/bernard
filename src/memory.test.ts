import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sanitizeKey, MemoryStore, loadRewriterHints, saveRewriterHint } from './memory.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const fs = await import('node:fs');

describe('sanitizeKey', () => {
  it('passes through alphanumeric characters', () => {
    expect(sanitizeKey('hello123')).toBe('hello123');
  });

  it('passes through hyphens and underscores', () => {
    expect(sanitizeKey('my-key_name')).toBe('my-key_name');
  });

  it('strips special characters', () => {
    expect(sanitizeKey('hello@world!')).toBe('helloworld');
  });

  it('strips path separators', () => {
    expect(sanitizeKey('../../../etc/passwd')).toBe('etcpasswd');
  });

  it('strips spaces', () => {
    expect(sanitizeKey('hello world')).toBe('helloworld');
  });
});

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new MemoryStore();
  });

  it('creates memory directory on construction', () => {
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('memory'), {
      recursive: true,
    });
  });

  describe('scratch operations (pure in-memory)', () => {
    it('lists empty scratch', () => {
      expect(store.listScratch()).toEqual([]);
    });

    it('writes and reads scratch', () => {
      store.writeScratch('key1', 'value1');
      expect(store.readScratch('key1')).toBe('value1');
    });

    it('returns null for missing scratch key', () => {
      expect(store.readScratch('nonexistent')).toBeNull();
    });

    it('lists scratch keys', () => {
      store.writeScratch('a', '1');
      store.writeScratch('b', '2');
      expect(store.listScratch()).toEqual(['a', 'b']);
    });

    it('deletes scratch key', () => {
      store.writeScratch('key1', 'value1');
      expect(store.deleteScratch('key1')).toBe(true);
      expect(store.readScratch('key1')).toBeNull();
    });

    it('returns false when deleting nonexistent scratch key', () => {
      expect(store.deleteScratch('nope')).toBe(false);
    });

    it('getAllScratchContents returns all entries', () => {
      store.writeScratch('a', '1');
      store.writeScratch('b', '2');
      const all = store.getAllScratchContents();
      expect(all.get('a')).toBe('1');
      expect(all.get('b')).toBe('2');
    });

    it('clearScratch removes all entries', () => {
      store.writeScratch('a', '1');
      store.clearScratch();
      expect(store.listScratch()).toEqual([]);
    });
  });

  describe('persistent memory (mocked fs)', () => {
    it('listMemory filters to .md files', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([
        'notes.md',
        'prefs.md',
        'other.txt',
        '.hidden',
      ] as any);
      expect(store.listMemory()).toEqual(['notes', 'prefs']);
    });

    it('readMemory returns content for existing file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('stored content');
      expect(store.readMemory('notes')).toBe('stored content');
    });

    it('readMemory returns null for missing file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.readMemory('missing')).toBeNull();
    });

    it('writeMemory writes file with sanitized key', () => {
      store.writeMemory('my-key', 'content');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('my-key.md'),
        'content',
        'utf-8',
      );
    });

    it('deleteMemory returns true when file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(store.deleteMemory('notes')).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('deleteMemory returns false when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.deleteMemory('missing')).toBe(false);
    });

    it('getAllMemoryContents returns all memory entries', () => {
      vi.mocked(fs.readdirSync).mockReturnValue(['a.md', 'b.md'] as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValueOnce('content-a').mockReturnValueOnce('content-b');
      const all = store.getAllMemoryContents();
      expect(all.get('a')).toBe('content-a');
      expect(all.get('b')).toBe('content-b');
    });
  });
});

describe('rewriter hints', () => {
  let store: MemoryStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new MemoryStore();
  });

  it('loadRewriterHints returns empty map when no hints file exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadRewriterHints(store).size).toBe(0);
  });

  it('loadRewriterHints parses arrow-delimited entries', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      '# Rewriter Hints\n\n- "my daughter" → daughter-allyson\n- "the car" -> car-tesla\n',
    );
    const hints = loadRewriterHints(store);
    expect(hints.get('my daughter')).toBe('daughter-allyson');
    expect(hints.get('the car')).toBe('car-tesla');
  });

  it('loadRewriterHints ignores non-matching lines', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      '# Rewriter Hints\n\nthis is not a hint\n- "x" → key-x\nrandom text\n',
    );
    const hints = loadRewriterHints(store);
    expect(hints.size).toBe(1);
    expect(hints.get('x')).toBe('key-x');
  });

  it('saveRewriterHint writes new mapping preserving existing entries', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      '# Rewriter Hints\n\n- "existing" → key-existing\n',
    );
    saveRewriterHint(store, 'my daughter', 'daughter-allyson');
    expect(fs.writeFileSync).toHaveBeenCalled();
    const [, written] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(written).toContain('# Rewriter Hints');
    expect(written).toContain('"existing" → key-existing');
    expect(written).toContain('"my daughter" → daughter-allyson');
  });

  it('saveRewriterHint overwrites the same phrase instead of duplicating', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      '# Rewriter Hints\n\n- "my daughter" → daughter-emma\n',
    );
    saveRewriterHint(store, 'my daughter', 'daughter-allyson');
    const [, written] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(written).toContain('"my daughter" → daughter-allyson');
    expect(written).not.toContain('daughter-emma');
  });
});
