import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnContextStore } from './turn-context.js';
import type { TurnContextRecord } from './turn-context.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const fs = await import('node:fs');

function makeRecord(turnIndex: number): TurnContextRecord {
  return {
    turnIndex,
    timestamp: 0,
    originalInput: `q${turnIndex}`,
    rewrittenInput: `Q${turnIndex}?`,
    resolvedReferences: [{ phrase: 'her', resolvedTo: 'Mia', sourceKey: 'people/mia' }],
    recalledFacts: [{ fact: 'Mia likes dogs', similarity: 0.42, domain: 'general' }],
  };
}

describe('TurnContextStore', () => {
  let store: TurnContextStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new TurnContextStore();
  });

  describe('load', () => {
    it('returns empty array when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(store.load()).toEqual([]);
    });

    it('returns empty array for corrupt JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json{{{');
      expect(store.load()).toEqual([]);
    });

    it('returns empty array for non-array JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{"turnIndex": 0}');
      expect(store.load()).toEqual([]);
    });

    it('filters entries missing required fields', () => {
      // The viewer dereferences originalInput/systemPrompt and maps over the
      // arrays unconditionally — a malformed persisted row must be dropped.
      const records = [
        makeRecord(0),
        { turnIndex: 'oops', originalInput: 'x', rewrittenInput: 'x', resolvedReferences: [], recalledFacts: [] },
        { turnIndex: 1, timestamp: 0, originalInput: 'x', rewrittenInput: 'x' }, // no arrays
        { turnIndex: 2, timestamp: 0, rewrittenInput: 'x', resolvedReferences: [], recalledFacts: [] }, // no originalInput
        makeRecord(3),
        null,
        42,
      ];
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(records));
      const result = store.load();
      expect(result).toHaveLength(2);
      expect(result[0].turnIndex).toBe(0);
      expect(result[1].turnIndex).toBe(3);
    });

    it('round-trips well-formed records', () => {
      const records = [makeRecord(0), makeRecord(1)];
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(records));
      expect(store.load()).toEqual(records);
    });
  });

  describe('save', () => {
    it('performs atomic write with tmp + rename', () => {
      const records = [makeRecord(0)];
      store.save(records);

      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('bernard'), {
        recursive: true,
      });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        JSON.stringify(records, null, 2),
        'utf-8',
      );
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.stringContaining('turn-context.json'),
      );
    });
  });

  describe('clear', () => {
    it('deletes the file when it exists', () => {
      store.clear();
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('turn-context.json'));
    });

    it('does not throw when file does not exist', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(() => store.clear()).not.toThrow();
    });
  });
});
