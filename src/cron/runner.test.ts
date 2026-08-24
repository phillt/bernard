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

const mockNotesStore = vi.hoisted(() => ({
  read: vi.fn().mockReturnValue({ jobId: 'job-123', entries: [] }),
  append: vi.fn(),
  listJobIds: vi.fn().mockReturnValue([]),
  clear: vi.fn(),
  entriesForRun: vi.fn().mockReturnValue([]),
}));

const mockMcpManager = vi.hoisted(() => ({
  connect: vi.fn(),
  getTools: vi.fn().mockReturnValue({}),
  getConnectedServerNames: vi.fn().mockReturnValue([]),
  getServerToolMap: vi.fn().mockReturnValue({}),
  // Mirrors the real `snapshot()`, which composes the three accessors — so a
  // test that steers one of them still steers the context cron actually gets.
  snapshot: vi.fn(function (this: any) {
    return {
      tools: this.getTools(),
      serverNames: this.getConnectedServerNames(),
      serverTools: this.getServerToolMap(),
    };
  }),
  close: vi.fn(),
}));

let capturedTools: Record<string, any> = {};
let capturedSystem: string = '';
let capturedMessages: any[] = [];

const mockGenerateText = vi.hoisted(() =>
  vi.fn().mockImplementation(async (opts: any) => {
    capturedTools = opts.tools || {};
    capturedSystem = opts.system || '';
    capturedMessages = opts.messages || [];
    return { text: 'done', response: { messages: [] } };
  }),
);

function capturedContextText(): string {
  return capturedMessages
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .join('\n');
}

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

vi.mock('./notes-store.js', () => ({
  CronNotesStore: vi.fn(() => mockNotesStore),
  MAX_NOTE_LENGTH: 1000,
}));

vi.mock('./notify.js', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('../mcp.js', () => ({
  MCPManager: vi.fn(() => mockMcpManager),
}));

vi.mock('../providers/index.js', () => ({
  getModel: vi.fn().mockReturnValue('mock-model'),
  getModelForConfig: vi.fn().mockReturnValue('mock-model'),
  getProviderOptions: vi.fn(() => undefined),
  getProviderOptionsForConfig: vi.fn(() => undefined),
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    loadConfig: vi.fn().mockReturnValue({
      provider: 'anthropic',
      model: 'test',
      maxTokens: 1024,
      shellTimeout: 5000,
      tokenWindow: 0,
      ragEnabled: true,
    }),
  };
});

vi.mock('../tools/shell.js', () => ({
  createShellTool: vi.fn().mockReturnValue({ type: 'mock-shell' }),
}));

vi.mock('../tools/memory.js', () => ({
  createMemoryTool: vi.fn().mockReturnValue({ type: 'mock-memory' }),
  createScratchTool: vi.fn().mockReturnValue({ type: 'mock-scratch' }),
}));

vi.mock('../tools/datetime.js', () => ({
  createDateTimeTool: vi.fn().mockReturnValue({ type: 'mock-datetime' }),
  formatCurrentDateTime: vi.fn().mockReturnValue('Friday, March 27, 2026 at 10:00 AM EDT'),
}));

vi.mock('../tools/web.js', () => ({
  createWebReadTool: vi.fn().mockReturnValue({ type: 'mock-web-read' }),
}));

vi.mock('../tools/wait.js', () => ({
  createWaitTool: vi.fn().mockReturnValue({ type: 'mock-wait' }),
}));

vi.mock('../tools/time.js', () => ({
  createTimeTools: vi.fn().mockReturnValue({
    time_range: { type: 'mock-time-range' },
    time_range_total: { type: 'mock-time-range-total' },
  }),
}));

vi.mock('../logger.js', () => ({
  debugLog: vi.fn(),
  isDebugEnabled: () => false,
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

import { runJob, resolveCronJobPosture } from './runner.js';
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

// Helper to build a minimal ConfirmActionInput for testing.
function confirmInput(risk: 'low' | 'medium' | 'high') {
  return { toolName: 'mock', args: {}, risk, reason: 'test' };
}

describe('runJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTools = {};
    capturedSystem = '';
    capturedMessages = [];
    mockRagSearch.mockResolvedValue([]);
    mockMemoryStore.getAllMemoryContents.mockReturnValue(new Map());
    mockMemoryStore.getAllScratchContents.mockReturnValue(new Map());
    // Re-set loadConfig mock since tests may override it
    vi.mocked(loadConfig).mockReturnValue({
      provider: 'anthropic',
      model: 'test',
      maxTokens: 1024,
      shellTimeout: 5000,
      tokenWindow: 0,
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

  it('includes RAG context in daemon context message when ragEnabled', async () => {
    mockRagSearch.mockResolvedValue([
      { fact: 'Server runs on port 3000', similarity: 0.9, domain: 'general' },
    ]);

    await runJob(testJob, vi.fn());

    const ctx = capturedContextText();
    expect(ctx).toContain('<recalled_context>');
    expect(ctx).toContain('Server runs on port 3000');
    expect(capturedSystem).not.toContain('Server runs on port 3000');
  });

  it('includes persistent memory in daemon context message', async () => {
    mockMemoryStore.getAllMemoryContents.mockReturnValue(
      new Map([['project', 'uses vitest for testing']]),
    );

    await runJob(testJob, vi.fn());

    const ctx = capturedContextText();
    expect(ctx).toContain('<persistent_memory>');
    expect(ctx).toContain('uses vitest for testing');
    expect(capturedSystem).not.toContain('uses vitest for testing');
  });

  it('includes scratch notes in daemon context message', async () => {
    mockMemoryStore.getAllScratchContents.mockReturnValue(new Map([['plan', 'step 1 done']]));

    await runJob(testJob, vi.fn());

    const ctx = capturedContextText();
    expect(ctx).toContain('<scratch_notes>');
    expect(ctx).toContain('step 1 done');
    expect(capturedSystem).not.toContain('step 1 done');
  });

  it('runs without RAG when ragEnabled is false', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      provider: 'anthropic',
      model: 'test',
      maxTokens: 1024,
      shellTimeout: 5000,
      tokenWindow: 0,
      ragEnabled: false,
      theme: 'bernard',
    });

    await runJob(testJob, vi.fn());

    expect(mockRagSearch).not.toHaveBeenCalled();
    expect(capturedSystem).toContain('daemon mode');
    expect(capturedContextText()).not.toContain('<recalled_context>');
  });

  it('uses job prompt as RAG search query', async () => {
    await runJob(testJob, vi.fn());

    expect(mockRagSearch).toHaveBeenCalledWith('Do the thing');
  });

  it('gracefully degrades when RAG search throws', async () => {
    mockRagSearch.mockRejectedValue(new Error('embedding service down'));

    const result = await runJob(testJob, vi.fn());

    expect(result.success).toBe(true);
    expect(capturedContextText()).not.toContain('<recalled_context>');
  });

  it('still contains base daemon prompt when memory context is added', async () => {
    mockRagSearch.mockResolvedValue([{ fact: 'test fact', similarity: 0.8, domain: 'general' }]);

    await runJob(testJob, vi.fn());

    expect(capturedSystem).toContain('daemon mode');
    expect(capturedContextText()).toContain('<recalled_context>');
  });

  it('includes web_read, wait, time_range, and time_range_total in tools', async () => {
    await runJob(testJob, vi.fn());

    expect(capturedTools).toHaveProperty('web_read');
    expect(capturedTools).toHaveProperty('wait');
    expect(capturedTools).toHaveProperty('time_range');
    expect(capturedTools).toHaveProperty('time_range_total');
  });

  it('includes current date and time in system prompt', async () => {
    await runJob(testJob, vi.fn());

    // Should contain the mocked formatCurrentDateTime() value
    expect(capturedSystem).toContain(
      'Current date and time: Friday, March 27, 2026 at 10:00 AM EDT',
    );
  });

  it('includes connected MCP server names in context message', async () => {
    mockMcpManager.getConnectedServerNames.mockReturnValue(['email', 'calendar']);

    await runJob(testJob, vi.fn());

    const ctx = capturedContextText();
    expect(ctx).toContain('email');
    expect(ctx).toContain('calendar');
    expect(ctx).toContain('<connected_mcp_servers>');
  });

  it('includes tool execution integrity rules in system prompt', async () => {
    await runJob(testJob, vi.fn());
    expect(capturedSystem).toContain('Tool Execution Integrity');
    expect(capturedSystem).toContain('NEVER simulate');
  });

  it('includes eventual consistency guidance in system prompt', async () => {
    await runJob(testJob, vi.fn());
    expect(capturedSystem).toContain('eventual consistency');
  });

  it('includes error handling rule in system prompt', async () => {
    await runJob(testJob, vi.fn());
    expect(capturedSystem).toContain('NEVER retry the exact same command');
  });

  // --- Scoped cron_notes_* tools (contract only; behavior covered in scoped-notes-tools.test.ts) ---

  it('includes scoped cron_notes_read and cron_notes_write in tools', async () => {
    await runJob(testJob, vi.fn());

    expect(capturedTools).toHaveProperty('cron_notes_read');
    expect(capturedTools).toHaveProperty('cron_notes_write');
  });

  it('includes Persistent Notes section in system prompt', async () => {
    await runJob(testJob, vi.fn());

    expect(capturedSystem).toContain('## Persistent Notes');
    expect(capturedSystem).toContain('cron_notes_read');
    expect(capturedSystem).toContain('cron_notes_write');
  });
});

// ---------------------------------------------------------------------------
// resolveCronJobPosture — unit tests for per-job permission posture (#260)
// ---------------------------------------------------------------------------

describe('resolveCronJobPosture', () => {
  const baseJob: CronJob = {
    id: 'job-1',
    name: 'Test',
    schedule: '* * * * *',
    prompt: 'do stuff',
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  // --- (a) Legacy / unset-fields behavior ---

  describe('unset fields — reproduces legacy behavior', () => {
    it('defaults toolMode to write', () => {
      const { toolMode } = resolveCronJobPosture(baseJob);
      expect(toolMode).toBe('write');
    });

    it('defaults confirmMode to auto', () => {
      const { confirmMode } = resolveCronJobPosture(baseJob);
      expect(confirmMode).toBe('auto');
    });

    it('defaults confirmThreshold to high', () => {
      const { confirmThreshold } = resolveCronJobPosture(baseJob);
      expect(confirmThreshold).toBe('high');
    });

    it('auto-denies high-risk calls', async () => {
      const { confirmAction } = resolveCronJobPosture(baseJob);
      expect(await confirmAction(confirmInput('high'))).toBe(false);
    });

    it('auto-approves medium-risk calls', async () => {
      const { confirmAction } = resolveCronJobPosture(baseJob);
      expect(await confirmAction(confirmInput('medium'))).toBe(true);
    });

    it('auto-approves low-risk calls', async () => {
      const { confirmAction } = resolveCronJobPosture(baseJob);
      expect(await confirmAction(confirmInput('low'))).toBe(true);
    });

    it('dangerous shell commands (risk:high) are auto-denied by the default posture', async () => {
      // Dangerous shell commands have meta.kind:'dangerous' → riskFromMeta → risk:'high'.
      // With default posture (confirmMode:'auto', threshold:'high'), augmentTools calls
      // confirmAction for high-risk tools; confirmAction returns false → DENIED.
      // This verifies the end-to-end posture for the default (legacy) cron case.
      const { confirmThreshold, confirmAction } = resolveCronJobPosture(baseJob);
      expect(confirmThreshold).toBe('high');
      // confirmAction is invoked by augmentTools when shouldConfirm(risk, threshold) is true.
      // shouldConfirm('high', 'high') === true, so confirmAction fires:
      expect(await confirmAction(confirmInput('high'))).toBe(false); // denied
    });
  });

  // --- (b) toolMode:'read-only' blocks writes even with confirmMode:'off' ---

  describe('toolMode:read-only + confirmMode:off — orthogonal axes', () => {
    const job: CronJob = { ...baseJob, toolMode: 'read-only', confirmMode: 'off' };

    it('resolves toolMode to read-only', () => {
      const { toolMode } = resolveCronJobPosture(job);
      expect(toolMode).toBe('read-only');
    });

    it('resolves confirmThreshold to never (confirmMode:off)', () => {
      const { confirmThreshold } = resolveCronJobPosture(job);
      expect(confirmThreshold).toBe('never');
    });

    it('confirmAction approves all risk levels (threshold:never)', async () => {
      const { confirmAction } = resolveCronJobPosture(job);
      expect(await confirmAction(confirmInput('high'))).toBe(true);
      expect(await confirmAction(confirmInput('medium'))).toBe(true);
      expect(await confirmAction(confirmInput('low'))).toBe(true);
    });

    it('toolMode is still read-only despite confirmMode:off (axes are orthogonal)', () => {
      // The confirm gate is open (threshold:never), but the block gate is still
      // wired as 'read-only'. This is the critical correctness property: a job
      // with confirmMode:'off' must not bypass the read-only block gate.
      const { toolMode, confirmThreshold } = resolveCronJobPosture(job);
      expect(toolMode).toBe('read-only');
      expect(confirmThreshold).toBe('never');
      // Both can be inspected independently — block gate reads toolMode, confirm
      // gate reads confirmThreshold. Neither overrides the other.
    });
  });

  // --- (c) skipPermissions:true dissolves both gates ---

  describe('skipPermissions:true — both gates dissolved', () => {
    const job: CronJob = { ...baseJob, skipPermissions: true };

    it('resolves toolMode to write', () => {
      const { toolMode } = resolveCronJobPosture(job);
      expect(toolMode).toBe('write');
    });

    it('resolves confirmMode to off', () => {
      const { confirmMode } = resolveCronJobPosture(job);
      expect(confirmMode).toBe('off');
    });

    it('resolves confirmThreshold to never', () => {
      const { confirmThreshold } = resolveCronJobPosture(job);
      expect(confirmThreshold).toBe('never');
    });

    it('confirmAction approves all risk levels', async () => {
      const { confirmAction } = resolveCronJobPosture(job);
      expect(await confirmAction(confirmInput('high'))).toBe(true);
      expect(await confirmAction(confirmInput('medium'))).toBe(true);
      expect(await confirmAction(confirmInput('low'))).toBe(true);
    });

    it('skipPermissions overrides any explicit toolMode:read-only', () => {
      const jobWithBoth: CronJob = { ...baseJob, skipPermissions: true, toolMode: 'read-only' };
      const { toolMode, confirmThreshold } = resolveCronJobPosture(jobWithBoth);
      expect(toolMode).toBe('write');
      expect(confirmThreshold).toBe('never');
    });

    it('dangerous shell commands (risk:high) are ALLOWED by skipPermissions (no safeguards)', async () => {
      // With skipPermissions:true the threshold is 'never', so augmentTools'
      // shouldConfirm(risk, 'never') short-circuits to false — confirmAction is
      // never called. Dangerous shell can run. This is the documented intent:
      // the user explicitly opted the job in to "no safeguards".
      const { confirmThreshold, confirmAction } = resolveCronJobPosture({
        ...baseJob,
        skipPermissions: true,
      });
      expect(confirmThreshold).toBe('never');
      // confirmAction is never called by augmentTools when threshold='never',
      // but if called directly it would return true (matches threshold logic):
      expect(await confirmAction(confirmInput('high'))).toBe(true);
    });
  });

  // --- Additional confirmMode variants ---

  describe('confirmMode:strict — denies high and medium risk', () => {
    const job: CronJob = { ...baseJob, confirmMode: 'strict' };

    it('resolves confirmThreshold to medium', () => {
      const { confirmThreshold } = resolveCronJobPosture(job);
      expect(confirmThreshold).toBe('medium');
    });

    it('auto-denies high-risk calls', async () => {
      const { confirmAction } = resolveCronJobPosture(job);
      expect(await confirmAction(confirmInput('high'))).toBe(false);
    });

    it('auto-denies medium-risk calls', async () => {
      const { confirmAction } = resolveCronJobPosture(job);
      expect(await confirmAction(confirmInput('medium'))).toBe(false);
    });

    it('auto-approves low-risk calls', async () => {
      const { confirmAction } = resolveCronJobPosture(job);
      expect(await confirmAction(confirmInput('low'))).toBe(true);
    });
  });

  describe('toolMode:read-only with default confirmMode — auto-deny high + block writes', () => {
    const job: CronJob = { ...baseJob, toolMode: 'read-only' };

    it('resolves toolMode to read-only', () => {
      expect(resolveCronJobPosture(job).toolMode).toBe('read-only');
    });

    it('resolves confirmThreshold to high (auto default)', () => {
      expect(resolveCronJobPosture(job).confirmThreshold).toBe('high');
    });

    it('still auto-denies high-risk calls via confirm gate', async () => {
      const { confirmAction } = resolveCronJobPosture(job);
      expect(await confirmAction(confirmInput('high'))).toBe(false);
    });
  });
});
