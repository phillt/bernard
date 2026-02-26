import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoutineTool } from './routine.js';

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

describe('createRoutineTool', () => {
  let tool: ReturnType<typeof createRoutineTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    tool = createRoutineTool();
  });

  describe('list action', () => {
    it('returns empty message when no routines', async () => {
      const result = await tool.execute({ action: 'list' }, {} as any);
      expect(result).toContain('No routines saved');
    });

    it('returns routine list when populated', async () => {
      const routine = {
        id: 'deploy',
        name: 'Deploy',
        description: 'Deploy app',
        content: 'steps',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['deploy.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(routine));

      const result = await tool.execute({ action: 'list' }, {} as any);
      expect(result).toContain('/deploy');
      expect(result).toContain('Deploy');
    });
  });

  describe('read action', () => {
    it('returns error when no id', async () => {
      const result = await tool.execute({ action: 'read' }, {} as any);
      expect(result).toContain('id is required');
    });

    it('returns routine content when found', async () => {
      const routine = {
        id: 'deploy',
        name: 'Deploy',
        description: 'Deploy the app',
        content: '1. Build\n2. Push',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(routine));

      const result = await tool.execute({ action: 'read', id: 'deploy' }, {} as any);
      expect(result).toContain('Deploy');
      expect(result).toContain('1. Build');
    });

    it('returns not-found for missing', async () => {
      const result = await tool.execute({ action: 'read', id: 'nope' }, {} as any);
      expect(result).toContain('No routine found');
    });
  });

  describe('create action', () => {
    it('creates routine successfully', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'deploy',
          name: 'Deploy',
          description: 'Deploy the app',
          content: '1. Build\n2. Push',
        },
        {} as any,
      );
      expect(result).toContain('created');
      expect(result).toContain('/deploy');
    });

    it('returns error for validation failure', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'BAD ID',
          name: 'Bad',
          description: 'desc',
          content: 'c',
        },
        {} as any,
      );
      expect(result).toContain('Error');
    });

    it('returns error for duplicate', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = await tool.execute(
        {
          action: 'create',
          id: 'deploy',
          name: 'Deploy',
          description: 'desc',
          content: 'c',
        },
        {} as any,
      );
      expect(result).toContain('already exists');
    });

    it('returns error when missing required fields', async () => {
      const noId = await tool.execute(
        { action: 'create', name: 'X', description: 'd', content: 'c' },
        {} as any,
      );
      expect(noId).toContain('id is required');

      const noName = await tool.execute(
        { action: 'create', id: 'x', description: 'd', content: 'c' },
        {} as any,
      );
      expect(noName).toContain('name is required');

      const noDesc = await tool.execute(
        { action: 'create', id: 'x', name: 'X', content: 'c' },
        {} as any,
      );
      expect(noDesc).toContain('description is required');

      const noContent = await tool.execute(
        { action: 'create', id: 'x', name: 'X', description: 'd' },
        {} as any,
      );
      expect(noContent).toContain('content is required');
    });
  });

  describe('update action', () => {
    it('updates routine successfully', async () => {
      const routine = {
        id: 'deploy',
        name: 'Deploy',
        description: 'Deploy app',
        content: 'old',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(routine));

      const result = await tool.execute(
        { action: 'update', id: 'deploy', content: 'new steps' },
        {} as any,
      );
      expect(result).toContain('updated');
    });

    it('returns not-found for missing routine', async () => {
      const result = await tool.execute(
        { action: 'update', id: 'nope', content: 'x' },
        {} as any,
      );
      expect(result).toContain('No routine found');
    });

    it('returns error when no id provided', async () => {
      const result = await tool.execute({ action: 'update', content: 'x' }, {} as any);
      expect(result).toContain('id is required');
    });

    it('returns error when no changes provided', async () => {
      const result = await tool.execute({ action: 'update', id: 'deploy' }, {} as any);
      expect(result).toContain('at least one field');
    });
  });

  describe('delete action', () => {
    it('deletes routine successfully', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = await tool.execute({ action: 'delete', id: 'deploy' }, {} as any);
      expect(result).toContain('deleted');
    });

    it('returns not-found for missing', async () => {
      const result = await tool.execute({ action: 'delete', id: 'nope' }, {} as any);
      expect(result).toContain('No routine found');
    });

    it('returns error when no id provided', async () => {
      const result = await tool.execute({ action: 'delete' }, {} as any);
      expect(result).toContain('id is required');
    });
  });
});
