import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSpecialistTool } from './specialist.js';
import type { CandidateStoreReader } from '../specialist-candidates.js';
import type { BernardConfig } from '../config.js';

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

describe('createSpecialistTool', () => {
  let tool: ReturnType<typeof createSpecialistTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    tool = createSpecialistTool();
  });

  describe('list action', () => {
    it('returns empty message when no specialists', async () => {
      const result = await tool.execute({ action: 'list' }, {} as any);
      expect(result).toContain('No specialists saved');
    });

    it('returns specialist list when populated', async () => {
      const specialist = {
        id: 'email-triage',
        name: 'Email Triage',
        description: 'Triage emails',
        systemPrompt: 'prompt',
        guidelines: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['email-triage.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute({ action: 'list' }, {} as any);
      expect(result).toContain('email-triage');
      expect(result).toContain('Email Triage');
    });
  });

  describe('read action', () => {
    it('returns error when no id', async () => {
      const result = await tool.execute({ action: 'read' }, {} as any);
      expect(result).toContain('id is required');
    });

    it('returns specialist content when found', async () => {
      const specialist = {
        id: 'email-triage',
        name: 'Email Triage',
        description: 'Triage emails',
        systemPrompt: 'You are an email triage specialist.',
        guidelines: ['Prioritize urgent'],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute({ action: 'read', id: 'email-triage' }, {} as any);
      expect(result).toContain('Email Triage');
      expect(result).toContain('email triage specialist');
      expect(result).toContain('Prioritize urgent');
    });

    it('returns not-found for missing', async () => {
      const result = await tool.execute({ action: 'read', id: 'nope' }, {} as any);
      expect(result).toContain('No specialist found');
    });
  });

  describe('create action', () => {
    it('creates specialist successfully', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'email-triage',
          name: 'Email Triage',
          description: 'Triage emails',
          systemPrompt: 'You are an email triage specialist.',
          guidelines: ['Prioritize urgent emails'],
        },
        {} as any,
      );
      expect(result).toContain('created');
      expect(result).toContain('email-triage');
    });

    it('creates specialist without guidelines', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'code-review',
          name: 'Code Review',
          description: 'Review code',
          systemPrompt: 'You are a code reviewer.',
        },
        {} as any,
      );
      expect(result).toContain('created');
    });

    it('returns error for validation failure', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'BAD ID',
          name: 'Bad',
          description: 'desc',
          systemPrompt: 'prompt',
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
          id: 'email-triage',
          name: 'Email Triage',
          description: 'desc',
          systemPrompt: 'prompt',
        },
        {} as any,
      );
      expect(result).toContain('already exists');
    });

    it('returns error when missing required fields', async () => {
      const noId = await tool.execute(
        { action: 'create', name: 'X', description: 'd', systemPrompt: 'p' },
        {} as any,
      );
      expect(noId).toContain('id is required');

      const noName = await tool.execute(
        { action: 'create', id: 'x', description: 'd', systemPrompt: 'p' },
        {} as any,
      );
      expect(noName).toContain('name is required');

      const noDesc = await tool.execute(
        { action: 'create', id: 'x', name: 'X', systemPrompt: 'p' },
        {} as any,
      );
      expect(noDesc).toContain('description is required');

      const noPrompt = await tool.execute(
        { action: 'create', id: 'x', name: 'X', description: 'd' },
        {} as any,
      );
      expect(noPrompt).toContain('systemPrompt is required');
    });
  });

  describe('update action', () => {
    it('updates specialist successfully', async () => {
      const specialist = {
        id: 'email-triage',
        name: 'Email Triage',
        description: 'Triage emails',
        systemPrompt: 'old prompt',
        guidelines: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute(
        { action: 'update', id: 'email-triage', systemPrompt: 'new prompt' },
        {} as any,
      );
      expect(result).toContain('updated');
    });

    it('updates guidelines', async () => {
      const specialist = {
        id: 'email-triage',
        name: 'Email Triage',
        description: 'Triage emails',
        systemPrompt: 'prompt',
        guidelines: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute(
        { action: 'update', id: 'email-triage', guidelines: ['New rule'] },
        {} as any,
      );
      expect(result).toContain('updated');
    });

    it('returns not-found for missing specialist', async () => {
      const result = await tool.execute(
        { action: 'update', id: 'nope', systemPrompt: 'x' },
        {} as any,
      );
      expect(result).toContain('No specialist found');
    });

    it('returns error when no id provided', async () => {
      const result = await tool.execute({ action: 'update', systemPrompt: 'x' }, {} as any);
      expect(result).toContain('id is required');
    });

    it('returns error when no changes provided', async () => {
      const result = await tool.execute({ action: 'update', id: 'email-triage' }, {} as any);
      expect(result).toContain('at least one field');
    });
  });

  describe('delete action', () => {
    it('deletes specialist successfully', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = await tool.execute({ action: 'delete', id: 'email-triage' }, {} as any);
      expect(result).toContain('deleted');
    });

    it('returns not-found for missing', async () => {
      const result = await tool.execute({ action: 'delete', id: 'nope' }, {} as any);
      expect(result).toContain('No specialist found');
    });

    it('returns error when no id provided', async () => {
      const result = await tool.execute({ action: 'delete' }, {} as any);
      expect(result).toContain('id is required');
    });
  });

  describe('candidateStore integration', () => {
    it('marks matching candidate as accepted on create by draftId', async () => {
      const mockCandidateStore = {
        listPending: vi
          .fn()
          .mockReturnValue([
            { id: 'cand-uuid-1', draftId: 'email-triage', name: 'Email Triage', status: 'pending' },
          ]),
        updateStatus: vi.fn(),
      } as CandidateStoreReader;

      const toolWithCandidates = createSpecialistTool(undefined, mockCandidateStore);

      const result = await toolWithCandidates.execute(
        {
          action: 'create',
          id: 'email-triage',
          name: 'Email Triage',
          description: 'Triage emails',
          systemPrompt: 'You are an email triage specialist.',
        },
        {} as any,
      );

      expect(result).toContain('created');
      expect(mockCandidateStore.updateStatus).toHaveBeenCalledWith('cand-uuid-1', 'accepted');
    });

    it('marks matching candidate as accepted on create by name (case-insensitive)', async () => {
      const mockCandidateStore = {
        listPending: vi
          .fn()
          .mockReturnValue([
            { id: 'cand-uuid-2', draftId: 'different-id', name: 'Code Review', status: 'pending' },
          ]),
        updateStatus: vi.fn(),
      } as CandidateStoreReader;

      const toolWithCandidates = createSpecialistTool(undefined, mockCandidateStore);

      const result = await toolWithCandidates.execute(
        {
          action: 'create',
          id: 'code-review',
          name: 'code review',
          description: 'Review code',
          systemPrompt: 'You are a code reviewer.',
        },
        {} as any,
      );

      expect(result).toContain('created');
      expect(mockCandidateStore.updateStatus).toHaveBeenCalledWith('cand-uuid-2', 'accepted');
    });

    it('does not call updateStatus when no candidate matches', async () => {
      const mockCandidateStore = {
        listPending: vi
          .fn()
          .mockReturnValue([
            { id: 'cand-uuid-3', draftId: 'other-specialist', name: 'Other', status: 'pending' },
          ]),
        updateStatus: vi.fn(),
      } as CandidateStoreReader;

      const toolWithCandidates = createSpecialistTool(undefined, mockCandidateStore);

      await toolWithCandidates.execute(
        {
          action: 'create',
          id: 'email-triage',
          name: 'Email Triage',
          description: 'Triage',
          systemPrompt: 'prompt',
        },
        {} as any,
      );

      expect(mockCandidateStore.updateStatus).not.toHaveBeenCalled();
    });

    it('still returns success when candidateStore.updateStatus throws', async () => {
      const mockCandidateStore = {
        listPending: vi
          .fn()
          .mockReturnValue([
            { id: 'cand-uuid-4', draftId: 'email-triage', name: 'Email Triage', status: 'pending' },
          ]),
        updateStatus: vi.fn().mockImplementation(() => {
          throw new Error('disk write failed');
        }),
      } as CandidateStoreReader;

      const toolWithCandidates = createSpecialistTool(undefined, mockCandidateStore);

      const result = await toolWithCandidates.execute(
        {
          action: 'create',
          id: 'email-triage',
          name: 'Email Triage',
          description: 'Triage emails',
          systemPrompt: 'You are an email triage specialist.',
        },
        {} as any,
      );

      expect(result).toContain('created');
      expect(mockCandidateStore.updateStatus).toHaveBeenCalled();
    });

    it('works without candidateStore (undefined)', async () => {
      const toolNoCandidates = createSpecialistTool();

      const result = await toolNoCandidates.execute(
        {
          action: 'create',
          id: 'email-triage',
          name: 'Email Triage',
          description: 'Triage',
          systemPrompt: 'prompt',
        },
        {} as any,
      );

      expect(result).toContain('created');
    });
  });

  describe('provider/model support', () => {
    it('creates specialist with provider and model', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'code-review',
          name: 'Code Review',
          description: 'Review code',
          systemPrompt: 'You are a code reviewer.',
          provider: 'xai',
          model: 'grok-code-fast-1',
        },
        {} as any,
      );
      expect(result).toContain('created');
    });

    it('returns error for invalid provider on create', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'test-spec',
          name: 'Test',
          description: 'Test',
          systemPrompt: 'prompt',
          provider: 'invalid-provider',
        },
        {} as any,
      );
      expect(result).toContain('Error');
      expect(result).toContain('Unknown provider');
    });

    it('returns error for invalid model on create', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'test-spec',
          name: 'Test',
          description: 'Test',
          systemPrompt: 'prompt',
          provider: 'xai',
          model: 'nonexistent-model',
        },
        {} as any,
      );
      expect(result).toContain('Error');
      expect(result).toContain('Unknown model');
    });

    it('validates model against global config provider when only model is specified on create', async () => {
      const config: BernardConfig = {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        maxTokens: 4096,
        shellTimeout: 30000,
        tokenWindow: 0,
        maxSteps: 25,
        ragEnabled: true,
        theme: 'bernard',
        criticMode: false,
        autoCreateSpecialists: false,
        autoCreateThreshold: 0.8,
        anthropicApiKey: 'sk-test',
      };
      const toolWithConfig = createSpecialistTool(undefined, undefined, config);

      const result = await toolWithConfig.execute(
        {
          action: 'create',
          id: 'test-spec',
          name: 'Test',
          description: 'Test',
          systemPrompt: 'prompt',
          model: 'nonexistent-model',
        },
        {} as any,
      );
      expect(result).toContain('Error');
      expect(result).toContain('Unknown model');
      expect(result).toContain('anthropic');
    });

    it('allows valid model without provider on create when config is provided', async () => {
      const config: BernardConfig = {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        maxTokens: 4096,
        shellTimeout: 30000,
        tokenWindow: 0,
        maxSteps: 25,
        ragEnabled: true,
        theme: 'bernard',
        criticMode: false,
        autoCreateSpecialists: false,
        autoCreateThreshold: 0.8,
        anthropicApiKey: 'sk-test',
      };
      const toolWithConfig = createSpecialistTool(undefined, undefined, config);

      const result = await toolWithConfig.execute(
        {
          action: 'create',
          id: 'test-spec',
          name: 'Test',
          description: 'Test',
          systemPrompt: 'prompt',
          model: 'claude-sonnet-4-5-20250929',
        },
        {} as any,
      );
      expect(result).toContain('created');
    });

    it('skips model-only validation when config is not provided', async () => {
      // Tool created without config — model-only should be allowed (validated at runtime)
      const toolNoConfig = createSpecialistTool();

      const result = await toolNoConfig.execute(
        {
          action: 'create',
          id: 'test-spec',
          name: 'Test',
          description: 'Test',
          systemPrompt: 'prompt',
          model: 'any-model-name',
        },
        {} as any,
      );
      expect(result).toContain('created');
    });

    it('allows provider without model on create', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'test-spec',
          name: 'Test',
          description: 'Test',
          systemPrompt: 'prompt',
          provider: 'xai',
        },
        {} as any,
      );
      expect(result).toContain('created');
    });

    it('updates specialist with provider and model', async () => {
      const specialist = {
        id: 'code-review',
        name: 'Code Review',
        description: 'Review code',
        systemPrompt: 'prompt',
        guidelines: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute(
        { action: 'update', id: 'code-review', provider: 'xai', model: 'grok-code-fast-1' },
        {} as any,
      );
      expect(result).toContain('updated');
    });

    it('returns error for invalid provider on update', async () => {
      const specialist = {
        id: 'code-review',
        name: 'Code Review',
        description: 'Review code',
        systemPrompt: 'prompt',
        guidelines: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute(
        { action: 'update', id: 'code-review', provider: 'bad-provider' },
        {} as any,
      );
      expect(result).toContain('Error');
      expect(result).toContain('Unknown provider');
    });

    it('shows model tag in list output', async () => {
      const specialist = {
        id: 'code-review',
        name: 'Code Review',
        description: 'Review code',
        systemPrompt: 'prompt',
        guidelines: [],
        provider: 'xai',
        model: 'grok-code-fast-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['code-review.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute({ action: 'list' }, {} as any);
      expect(result).toContain('[xai/grok-code-fast-1]');
    });

    it('shows model override section in read output', async () => {
      const specialist = {
        id: 'code-review',
        name: 'Code Review',
        description: 'Review code',
        systemPrompt: 'prompt',
        guidelines: [],
        provider: 'xai',
        model: 'grok-code-fast-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute({ action: 'read', id: 'code-review' }, {} as any);
      expect(result).toContain('Model Override');
      expect(result).toContain('Provider: xai');
      expect(result).toContain('Model: grok-code-fast-1');
    });

    it('auto-clears model when provider is cleared on update', async () => {
      const specialist = {
        id: 'code-review',
        name: 'Code Review',
        description: 'Review code',
        systemPrompt: 'prompt',
        guidelines: [],
        provider: 'xai',
        model: 'grok-code-fast-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute(
        { action: 'update', id: 'code-review', provider: '' },
        {} as any,
      );
      expect(result).toContain('updated');

      // Verify the written data has both provider and model cleared (store deletes the keys)
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.provider).toBeUndefined();
      expect(written.model).toBeUndefined();
    });

    it('validates model-only update against specialist existing provider', async () => {
      const config: BernardConfig = {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        maxTokens: 4096,
        shellTimeout: 30000,
        tokenWindow: 0,
        maxSteps: 25,
        ragEnabled: true,
        theme: 'bernard',
        criticMode: false,
        autoCreateSpecialists: false,
        autoCreateThreshold: 0.8,
        anthropicApiKey: 'sk-test',
      };
      const toolWithConfig = createSpecialistTool(undefined, undefined, config);

      const specialist = {
        id: 'code-review',
        name: 'Code Review',
        description: 'Review code',
        systemPrompt: 'prompt',
        guidelines: [],
        provider: 'xai',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await toolWithConfig.execute(
        { action: 'update', id: 'code-review', model: 'nonexistent-model' },
        {} as any,
      );
      expect(result).toContain('Error');
      expect(result).toContain('Unknown model');
      expect(result).toContain('xai');
    });

    it('does not show model override section when no override set', async () => {
      const specialist = {
        id: 'code-review',
        name: 'Code Review',
        description: 'Review code',
        systemPrompt: 'prompt',
        guidelines: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute({ action: 'read', id: 'code-review' }, {} as any);
      expect(result).not.toContain('Model Override');
    });
  });

  describe('create action with new schema fields', () => {
    it('creates specialist with kind tool-wrapper', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'shell-wrapper',
          name: 'Shell Wrapper',
          description: 'Wraps shell tool',
          systemPrompt: 'You are a shell wrapper.',
          kind: 'tool-wrapper',
        },
        {} as any,
      );
      expect(result).toContain('created');
      expect(result).toContain('shell-wrapper');
    });

    it('creates specialist with kind meta', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'meta-spec',
          name: 'Meta Specialist',
          description: 'Operates on other specialists',
          systemPrompt: 'You are a meta specialist.',
          kind: 'meta',
        },
        {} as any,
      );
      expect(result).toContain('created');
    });

    it('creates specialist with targetTools', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'file-wrapper',
          name: 'File Wrapper',
          description: 'Wraps file tools',
          systemPrompt: 'You are a file wrapper.',
          kind: 'tool-wrapper',
          targetTools: ['file_read_lines', 'file_edit_lines'],
        },
        {} as any,
      );
      expect(result).toContain('created');
    });

    it('creates specialist with goodExamples', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'ex-wrapper',
          name: 'Example Wrapper',
          description: 'Has examples',
          systemPrompt: 'prompt',
          goodExamples: [{ input: 'list files', call: 'ls -la' }],
        },
        {} as any,
      );
      expect(result).toContain('created');
    });

    it('creates specialist with badExamples', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'bad-ex-wrapper',
          name: 'Bad Example Wrapper',
          description: 'Has bad examples',
          systemPrompt: 'prompt',
          badExamples: [
            { input: 'bad cmd', call: 'rm -rf /', error: 'dangerous', fix: 'use safe path' },
          ],
        },
        {} as any,
      );
      expect(result).toContain('created');
    });

    it('creates specialist with structuredOutput', async () => {
      const result = await tool.execute(
        {
          action: 'create',
          id: 'structured-wrapper',
          name: 'Structured Wrapper',
          description: 'Returns structured JSON',
          systemPrompt: 'Return JSON always.',
          structuredOutput: true,
        },
        {} as any,
      );
      expect(result).toContain('created');
    });
  });

  describe('update action with new schema fields', () => {
    const baseSpecialist = {
      id: 'shell-wrapper',
      name: 'Shell Wrapper',
      description: 'Wraps shell',
      systemPrompt: 'prompt',
      guidelines: [],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    it('updates kind field', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(baseSpecialist));

      const result = await tool.execute(
        { action: 'update', id: 'shell-wrapper', kind: 'tool-wrapper' },
        {} as any,
      );
      expect(result).toContain('updated');
    });

    it('updates targetTools field', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(baseSpecialist));

      const result = await tool.execute(
        { action: 'update', id: 'shell-wrapper', targetTools: ['shell'] },
        {} as any,
      );
      expect(result).toContain('updated');
    });

    it('updates goodExamples field', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(baseSpecialist));

      const result = await tool.execute(
        {
          action: 'update',
          id: 'shell-wrapper',
          goodExamples: [{ input: 'list files', call: 'ls -la' }],
        },
        {} as any,
      );
      expect(result).toContain('updated');
    });

    it('updates badExamples field', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(baseSpecialist));

      const result = await tool.execute(
        {
          action: 'update',
          id: 'shell-wrapper',
          badExamples: [{ input: 'bad', call: 'bad', error: 'err', fix: 'fixed' }],
        },
        {} as any,
      );
      expect(result).toContain('updated');
    });

    it('updates structuredOutput field', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(baseSpecialist));

      const result = await tool.execute(
        { action: 'update', id: 'shell-wrapper', structuredOutput: true },
        {} as any,
      );
      expect(result).toContain('updated');
    });

    it('returns error when only unrecognised fields are provided on update', async () => {
      // No id provided — should return error before hitting the store
      const result = await tool.execute({ action: 'update' }, {} as any);
      expect(result).toContain('id is required');
    });
  });

  describe('read action with new schema fields', () => {
    it('shows Kind section for tool-wrapper kind', async () => {
      const specialist = {
        id: 'shell-wrapper',
        name: 'Shell Wrapper',
        description: 'Wraps shell',
        systemPrompt: 'prompt',
        guidelines: [],
        kind: 'tool-wrapper',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute({ action: 'read', id: 'shell-wrapper' }, {} as any);
      expect(result).toContain('Kind: tool-wrapper');
    });

    it('does not show Kind section for persona kind', async () => {
      const specialist = {
        id: 'persona-spec',
        name: 'Persona Spec',
        description: 'A persona',
        systemPrompt: 'prompt',
        guidelines: [],
        kind: 'persona',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute({ action: 'read', id: 'persona-spec' }, {} as any);
      expect(result).not.toContain('Kind:');
    });

    it('shows Target tools section when targetTools are set', async () => {
      const specialist = {
        id: 'file-wrapper',
        name: 'File Wrapper',
        description: 'Wraps file tools',
        systemPrompt: 'prompt',
        guidelines: [],
        kind: 'tool-wrapper',
        targetTools: ['file_read_lines', 'file_edit_lines'],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute({ action: 'read', id: 'file-wrapper' }, {} as any);
      expect(result).toContain('Target tools:');
      expect(result).toContain('file_read_lines');
      expect(result).toContain('file_edit_lines');
    });

    it('shows Structured output section when structuredOutput is true', async () => {
      const specialist = {
        id: 'structured-wrapper',
        name: 'Structured Wrapper',
        description: 'Returns structured JSON',
        systemPrompt: 'Return JSON always.',
        guidelines: [],
        structuredOutput: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute({ action: 'read', id: 'structured-wrapper' }, {} as any);
      expect(result).toContain('Structured output: true');
    });

    it('shows Good Examples section when goodExamples are set', async () => {
      const specialist = {
        id: 'ex-wrapper',
        name: 'Example Wrapper',
        description: 'Has examples',
        systemPrompt: 'prompt',
        guidelines: [],
        goodExamples: [{ input: 'list files', call: 'ls -la', note: 'basic listing' }],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute({ action: 'read', id: 'ex-wrapper' }, {} as any);
      expect(result).toContain('Good Examples');
      expect(result).toContain('list files');
      expect(result).toContain('ls -la');
      expect(result).toContain('basic listing');
    });

    it('shows Bad Examples section when badExamples are set', async () => {
      const specialist = {
        id: 'bad-ex-wrapper',
        name: 'Bad Example Wrapper',
        description: 'Has bad examples',
        systemPrompt: 'prompt',
        guidelines: [],
        badExamples: [
          {
            input: 'bad cmd',
            call: 'rm -rf /',
            error: 'dangerous',
            fix: 'use safe path',
            note: 'never do this',
          },
        ],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));

      const result = await tool.execute({ action: 'read', id: 'bad-ex-wrapper' }, {} as any);
      expect(result).toContain('Bad Examples');
      expect(result).toContain('bad cmd');
      expect(result).toContain('dangerous');
      expect(result).toContain('use safe path');
      expect(result).toContain('never do this');
    });
  });
});
