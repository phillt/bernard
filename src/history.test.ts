import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HistoryStore } from './history.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const fs = await import('node:fs');

describe('HistoryStore', () => {
  let store: HistoryStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new HistoryStore();
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
      vi.mocked(fs.readFileSync).mockReturnValue('{"role": "user"}');
      expect(store.load()).toEqual([]);
    });

    it('filters entries without role property', () => {
      const data = JSON.stringify([
        { role: 'user', content: 'hello' },
        { content: 'no role' },
        { role: 'assistant', content: 'hi' },
        42,
        null,
      ]);
      vi.mocked(fs.readFileSync).mockReturnValue(data);
      const result = store.load();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: 'user', content: 'hello' });
      expect(result[1]).toEqual({ role: 'assistant', content: 'hi' });
    });

    it('returns valid messages from well-formed file', () => {
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ];
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(messages));
      expect(store.load()).toEqual(messages);
    });
  });

  describe('save', () => {
    it('performs atomic write with tmp + rename', () => {
      const messages = [{ role: 'user' as const, content: 'hello' }];
      store.save(messages);

      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('bernard'), {
        recursive: true,
      });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        JSON.stringify(messages, null, 2),
        'utf-8',
      );
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.stringContaining('conversation-history.json'),
      );
    });
  });

  describe('clear', () => {
    it('deletes the history file when it exists', () => {
      store.clear();
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('conversation-history.json'),
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
