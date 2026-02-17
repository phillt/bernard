import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks ---

const mockStore = vi.hoisted(() => ({
  loadJobs: vi.fn().mockReturnValue([]),
  getJob: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  deleteJob: vi.fn(),
  saveJobs: vi.fn(),
  createAlert: vi.fn().mockReturnValue({ id: 'alert-1' }),
  listAlerts: vi.fn().mockReturnValue([]),
}));

const mockLogStore = vi.hoisted(() => ({
  appendEntry: vi.fn(),
}));

const mockMcpManager = vi.hoisted(() => ({
  connect: vi.fn(),
  getTools: vi.fn().mockReturnValue({}),
  getConnectedServerNames: vi.fn().mockReturnValue([]),
  close: vi.fn(),
}));

let capturedTools: Record<string, any> = {};
let capturedSystem: string = '';

const mockGenerateText = vi.hoisted(() =>
  vi.fn().mockImplementation(async (opts: any) => {
    capturedTools = opts.tools || {};
    capturedSystem = opts.system || '';
    return { text: 'done', response: { messages: [] } };
  }),
);

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: mockGenerateText,
  };
});

vi.mock('./store.js', () => ({
  CronStore: vi.fn(() => mockStore),
}));

vi.mock('./log-store.js', () => ({
  CronLogStore: vi.fn(() => mockLogStore),
}));

vi.mock('./notify.js', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('../mcp.js', () => ({
  MCPManager: vi.fn(() => mockMcpManager),
}));

vi.mock('../providers/index.js', () => ({
  getModel: vi.fn().mockReturnValue('mock-model'),
}));

vi.mock('../config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    provider: 'anthropic',
    model: 'test',
    maxTokens: 1024,
    shellTimeout: 5000,
    ragEnabled: true,
  }),
}));

vi.mock('../tools/shell.js', () => ({
  createShellTool: vi.fn().mockReturnValue({ type: 'mock-shell' }),
}));

vi.mock('../tools/memory.js', () => ({
  createMemoryTool: vi.fn().mockReturnValue({ type: 'mock-memory' }),
  createScratchTool: vi.fn().mockReturnValue({ type: 'mock-scratch' }),
}));

vi.mock('../tools/datetime.js', () => ({
  createDateTimeTool: vi.fn().mockReturnValue({ type: 'mock-datetime' }),
}));

vi.mock('../logger.js', () => ({
  debugLog: vi.fn(),
}));

// Mock MemoryStore with functional getAllMemoryContents/getAllScratchContents
const mockMemoryStore = vi.hoisted(() => ({
  getAllMemoryContents: vi.fn().mockReturnValue(new Map()),
  getAllScratchContents: vi.fn().mockReturnValue(new Map()),
}));

vi.mock('../memory.js', () => ({
  MemoryStore: vi.fn(() => mockMemoryStore),
}));

// Mock RAGStore
const mockRagSearch = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockRagStoreInstance = vi.hoisted(() => ({
  search: mockRagSearch,
}));

vi.mock('../rag.js', () => ({
  RAGStore: vi.fn(() => mockRagStoreInstance),
}));

import { runJob } from './runner.js';
import { loadConfig } from '../config.js';
import type { CronJob } from './types.js';

const testJob: CronJob = {
  id: 'job-123',
  name: 'Test Job',
  schedule: '*/15 * * * *',
  prompt: 'Do the thing',
  enabled: true,
  createdAt: new Date().toISOString(),
};

describe('runJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTools = {};
    capturedSystem = '';
    mockRagSearch.mockResolvedValue([]);
    mockMemoryStore.getAllMemoryContents.mockReturnValue(new Map());
    mockMemoryStore.getAllScratchContents.mockReturnValue(new Map());
    // Re-set loadConfig mock since tests may override it
    vi.mocked(loadConfig).mockReturnValue({
      provider: 'anthropic',
      model: 'test',
      maxTokens: 1024,
      shellTimeout: 5000,
      ragEnabled: true,
      theme: 'bernard',
    });
  });

  it('includes cron_self_disable in tools passed to generateText', async () => {
    await runJob(testJob, vi.fn());

    expect(capturedTools).toHaveProperty('cron_self_disable');
    expect(capturedTools.cron_self_disable).toBeDefined();
  });

  it('cron_self_disable execute disables the job in the store', async () => {
    mockStore.updateJob.mockReturnValue({ ...testJob, enabled: false });

    await runJob(testJob, vi.fn());

    const selfDisable = capturedTools.cron_self_disable;
    const result = await selfDisable.execute({ reason: 'Task completed' });

    expect(mockStore.updateJob).toHaveBeenCalledWith('job-123', { enabled: false });
    expect(result).toContain('Test Job');
    expect(result).toContain('disabled');
    expect(result).toContain('Task completed');
  });

  it('cron_self_disable returns error when job not found', async () => {
    mockStore.updateJob.mockReturnValue(undefined);

    await runJob(testJob, vi.fn());

    const selfDisable = capturedTools.cron_self_disable;
    const result = await selfDisable.execute({ reason: 'Done' });

    expect(result).toContain('Error');
    expect(result).toContain('job-123');
  });

  // --- Memory/RAG injection tests ---

  it('includes RAG context in daemon system prompt when ragEnabled', async () => {
    mockRagSearch.mockResolvedValue([
      { fact: 'Server runs on port 3000', similarity: 0.9, domain: 'general' },
    ]);

    await runJob(testJob, vi.fn());

    expect(capturedSystem).toContain('Recalled Context');
    expect(capturedSystem).toContain('Server runs on port 3000');
  });

  it('includes persistent memory in daemon system prompt', async () => {
    mockMemoryStore.getAllMemoryContents.mockReturnValue(
      new Map([['project', 'uses vitest for testing']]),
    );

    await runJob(testJob, vi.fn());

    expect(capturedSystem).toContain('Persistent Memory');
    expect(capturedSystem).toContain('uses vitest for testing');
  });

  it('excludes scratch notes from daemon system prompt', async () => {
    mockMemoryStore.getAllScratchContents.mockReturnValue(new Map([['plan', 'step 1 done']]));

    await runJob(testJob, vi.fn());

    expect(capturedSystem).not.toContain('Scratch Notes');
    expect(capturedSystem).not.toContain('step 1 done');
  });

  it('runs without RAG when ragEnabled is false', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      provider: 'anthropic',
      model: 'test',
      maxTokens: 1024,
      shellTimeout: 5000,
      ragEnabled: false,
      theme: 'bernard',
    });

    await runJob(testJob, vi.fn());

    expect(mockRagSearch).not.toHaveBeenCalled();
    expect(capturedSystem).toContain('daemon mode');
    expect(capturedSystem).not.toContain('Recalled Context');
  });

  it('uses job prompt as RAG search query', async () => {
    await runJob(testJob, vi.fn());

    expect(mockRagSearch).toHaveBeenCalledWith('Do the thing');
  });

  it('gracefully degrades when RAG search throws', async () => {
    mockRagSearch.mockRejectedValue(new Error('embedding service down'));

    const result = await runJob(testJob, vi.fn());

    expect(result.success).toBe(true);
    expect(capturedSystem).not.toContain('Recalled Context');
  });

  it('still contains base daemon prompt when memory context is added', async () => {
    mockRagSearch.mockResolvedValue([{ fact: 'test fact', similarity: 0.8, domain: 'general' }]);

    await runJob(testJob, vi.fn());

    expect(capturedSystem).toContain('daemon mode');
    expect(capturedSystem).toContain('Recalled Context');
  });
});
