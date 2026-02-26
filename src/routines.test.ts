import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RoutineStore } from './routines.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}));

const fs = await import('node:fs');

/** Mock existsSync to return true for directory checks, false for file checks. */
function mockDirExists(): void {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const s = String(p);
    return !s.endsWith('.json');
  });
}

describe('RoutineStore', () => {
  let store: RoutineStore;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    store = new RoutineStore();
  });

  it('constructor creates directory', () => {
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('routines'), {
      recursive: true,
    });
  });

  describe('validateId', () => {
    it('rejects empty string', () => {
      expect(store.validateId('')).toBeTruthy();
    });

    it('rejects uppercase', () => {
      expect(store.validateId('Deploy')).toBeTruthy();
    });

    it('rejects special characters', () => {
      expect(store.validateId('deploy_staging')).toBeTruthy();
      expect(store.validateId('deploy.staging')).toBeTruthy();
      expect(store.validateId('deploy staging')).toBeTruthy();
    });

    it('rejects leading hyphen', () => {
      expect(store.validateId('-deploy')).toBeTruthy();
    });

    it('rejects trailing hyphen', () => {
      expect(store.validateId('deploy-')).toBeTruthy();
    });

    it('rejects reserved names', () => {
      expect(store.validateId('help')).toContain('reserved');
      expect(store.validateId('clear')).toContain('reserved');
      expect(store.validateId('memory')).toContain('reserved');
      expect(store.validateId('routines')).toContain('reserved');
      expect(store.validateId('exit')).toContain('reserved');
    });

    it('accepts valid kebab-case', () => {
      expect(store.validateId('deploy')).toBeNull();
      expect(store.validateId('deploy-staging')).toBeNull();
      expect(store.validateId('my-workflow-123')).toBeNull();
      expect(store.validateId('a')).toBeNull();
      expect(store.validateId('x1')).toBeNull();
    });

    it('rejects IDs over 60 characters', () => {
      const longId = 'a'.repeat(61);
      expect(store.validateId(longId)).toBeTruthy();
    });

    it('accepts 60-character ID', () => {
      const id60 = 'a'.repeat(60);
      expect(store.validateId(id60)).toBeNull();
    });
  });

  describe('list', () => {
    it('returns empty array when no files', () => {
      expect(store.list()).toEqual([]);
    });

    it('returns sorted routines', () => {
      const routineB = {
        id: 'deploy',
        name: 'Deploy',
        description: 'Deploy app',
        content: 'steps',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      const routineA = {
        id: 'build',
        name: 'Build',
        description: 'Build app',
        content: 'steps',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['deploy.json', 'build.json'] as any);
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(JSON.stringify(routineB))
        .mockReturnValueOnce(JSON.stringify(routineA));
      const result = store.list();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('build');
      expect(result[1].id).toBe('deploy');
    });

    it('skips corrupt files', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['good.json', 'bad.json'] as any);
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(
          JSON.stringify({
            id: 'good',
            name: 'Good',
            description: 'desc',
            content: 'c',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          }),
        )
        .mockReturnValueOnce('not json{{{');
      const result = store.list();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('good');
    });
  });

  describe('get', () => {
    it('returns routine by id', () => {
      const routine = {
        id: 'deploy',
        name: 'Deploy',
        description: 'Deploy app',
        content: 'steps',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(routine));
      expect(store.get('deploy')).toEqual(routine);
    });

    it('returns undefined for missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.get('nope')).toBeUndefined();
    });
  });

  describe('create', () => {
    it('writes correct structure', () => {
      mockDirExists();
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      const routine = store.create('deploy', 'Deploy', 'Deploy the app', '1. Build\n2. Push');
      expect(routine.id).toBe('deploy');
      expect(routine.name).toBe('Deploy');
      expect(routine.description).toBe('Deploy the app');
      expect(routine.content).toBe('1. Build\n2. Push');
      expect(routine.createdAt).toBeTruthy();
      expect(routine.updatedAt).toBe(routine.createdAt);
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
    });

    it('throws on invalid id', () => {
      expect(() => store.create('BAD', 'Bad', 'desc', 'content')).toThrow();
    });

    it('throws on reserved name', () => {
      expect(() => store.create('help', 'Help', 'desc', 'content')).toThrow('reserved');
    });

    it('throws on duplicate', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(() => store.create('deploy', 'Deploy', 'desc', 'content')).toThrow('already exists');
    });

    it('throws at MAX_ROUTINES', () => {
      mockDirExists();
      const files = Array.from({ length: 100 }, (_, i) => `r${i}.json`);
      vi.mocked(fs.readdirSync).mockReturnValue(files as any);
      const routineData = {
        id: 'x',
        name: 'X',
        description: 'd',
        content: 'c',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(routineData));
      expect(() => store.create('new-one', 'New', 'desc', 'content')).toThrow('Maximum');
    });
  });

  describe('update', () => {
    it('merges fields and bumps updatedAt', () => {
      const original = {
        id: 'deploy',
        name: 'Deploy',
        description: 'Deploy app',
        content: 'old steps',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(original));
      const updated = store.update('deploy', { content: 'new steps' });
      expect(updated).toBeDefined();
      expect(updated!.content).toBe('new steps');
      expect(updated!.name).toBe('Deploy');
      expect(updated!.updatedAt).not.toBe(original.updatedAt);
    });

    it('returns undefined for missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.update('nope', { name: 'X' })).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('removes file and returns true', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(store.delete('deploy')).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('returns false for missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.delete('nope')).toBe(false);
    });
  });

  describe('exists', () => {
    it('returns true when file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(store.exists('deploy')).toBe(true);
    });

    it('returns false when file missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.exists('deploy')).toBe(false);
    });
  });

  describe('getSummaries', () => {
    it('returns id, name, description only', () => {
      const routine = {
        id: 'deploy',
        name: 'Deploy',
        description: 'Deploy app',
        content: 'long steps...',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['deploy.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(routine));
      const summaries = store.getSummaries();
      expect(summaries).toEqual([{ id: 'deploy', name: 'Deploy', description: 'Deploy app' }]);
    });
  });
});
