import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProvenanceHistoryStore } from './provenance-history.js';
import type { TurnProvenance } from './provenance.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const fs = await import('node:fs');

function makeRecord(turnIndex: number): TurnProvenance {
  return {
    turnIndex,
    userInput: `q${turnIndex}`,
    sources: [
      {
        id: 'S1',
        kind: 'web',
        label: 'example',
        contentPreview: 'preview',
        rawRef: 'https://example.com',
        timestamp: 0,
      },
    ],
    citedIds: ['S1'],
    timestamp: 0,
  };
}

describe('ProvenanceHistoryStore', () => {
  let store: ProvenanceHistoryStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ProvenanceHistoryStore();
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
      const records = [
        makeRecord(0),
        { turnIndex: 'oops', sources: [], citedIds: [] },
        { sources: [], citedIds: [] },
        makeRecord(1),
        null,
        42,
      ];
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(records));
      const result = store.load();
      expect(result).toHaveLength(2);
      expect(result[0].turnIndex).toBe(0);
      expect(result[1].turnIndex).toBe(1);
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
        expect.stringContaining('provenance-history.json'),
      );
    });
  });

  describe('clear', () => {
    it('deletes the history file when it exists', () => {
      store.clear();
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('provenance-history.json'),
      );
    });

    it('does not throw when file does not exist', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(() => store.clear()).not.toThrow();
    });
  });
});
