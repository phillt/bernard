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

const mockGenerateText = vi.hoisted(() =>
  vi.fn().mockImplementation(async (opts: any) => {
    capturedTools = opts.tools || {};
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

vi.mock('../memory.js', () => ({
  MemoryStore: vi.fn(() => ({})),
}));

import { runJob } from './runner.js';
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
});
