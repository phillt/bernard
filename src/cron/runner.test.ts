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

vi.mock('../config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    provider: 'anthropic',
    model: 'test',
    maxTokens: 1024,
    shellTimeout: 5000,
    tokenWindow: 0,
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

import { runJob, resolveCronPermissions } from './runner.js';
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

  it('includes scratch notes in daemon system prompt', async () => {
    mockMemoryStore.getAllScratchContents.mockReturnValue(new Map([['plan', 'step 1 done']]));

    await runJob(testJob, vi.fn());

    expect(capturedSystem).toContain('Scratch Notes');
    expect(capturedSystem).toContain('step 1 done');
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

  it('includes connected MCP server names in system prompt', async () => {
    mockMcpManager.getConnectedServerNames.mockReturnValue(['email', 'calendar']);

    await runJob(testJob, vi.fn());

    expect(capturedSystem).toContain('Connected MCP servers: email, calendar');
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

// --- resolveCronPermissions unit tests ---

describe('resolveCronPermissions', () => {
  // Helper: build a minimal write-capable MCP tool stub
  const makeMcpTool = (name: string) => ({
    description: `Mock ${name}`,
    execute: async () => `result of ${name}`,
  });

  // -------------------------------------------------------------------------
  // (a) Legacy / unset-fields behavior: high-risk shell denied, non-high-risk proceeds
  // -------------------------------------------------------------------------
  describe('unset fields (legacy defaults)', () => {
    it('denies dangerous shell commands', async () => {
      const { confirmDangerous } = resolveCronPermissions({});
      const allowed = await confirmDangerous('rm -rf /important');
      expect(allowed).toBe(false);
    });

    it('also denies dangerous shell commands when confirmMode is auto', async () => {
      const { confirmDangerous } = resolveCronPermissions({ confirmMode: 'auto' });
      const allowed = await confirmDangerous('sudo something');
      expect(allowed).toBe(false);
    });

    it('also denies dangerous shell commands when confirmMode is strict', async () => {
      const { confirmDangerous } = resolveCronPermissions({ confirmMode: 'strict' });
      const allowed = await confirmDangerous('rm -rf /');
      expect(allowed).toBe(false);
    });

    it('passes MCP tools through unchanged', async () => {
      const mcpTools = {
        'email__send_email': makeMcpTool('email__send_email'),
        'calendar__create_event': makeMcpTool('calendar__create_event'),
      };
      const { filterMcpTools } = resolveCronPermissions({});
      const filtered = filterMcpTools(mcpTools);
      // Both tools should be the same object references (unmodified)
      expect(filtered['email__send_email']).toBe(mcpTools['email__send_email']);
      expect(filtered['calendar__create_event']).toBe(mcpTools['calendar__create_event']);
    });
  });

  // -------------------------------------------------------------------------
  // (b) read-only toolMode: blocks write tools, allows read-only tools
  // -------------------------------------------------------------------------
  describe('toolMode: read-only', () => {
    it('still denies dangerous shell commands', async () => {
      const { confirmDangerous } = resolveCronPermissions({ toolMode: 'read-only' });
      const allowed = await confirmDangerous('rm -rf /tmp/foo');
      expect(allowed).toBe(false);
    });

    it('blocks write-capable MCP tools (no read-only suffix)', async () => {
      const mcpTools = {
        'email__send_email': makeMcpTool('email__send_email'),
        'calendar__create_event': makeMcpTool('calendar__create_event'),
        'github__create_issue': makeMcpTool('github__create_issue'),
      };
      const { filterMcpTools } = resolveCronPermissions({ toolMode: 'read-only' });
      const filtered = filterMcpTools(mcpTools);

      // Stubs should be different objects from originals
      expect(filtered['email__send_email']).not.toBe(mcpTools['email__send_email']);
      expect(filtered['calendar__create_event']).not.toBe(mcpTools['calendar__create_event']);
      expect(filtered['github__create_issue']).not.toBe(mcpTools['github__create_issue']);

      // Stubs should return a blocked-message string
      const result = await filtered['email__send_email'].execute({});
      expect(typeof result).toBe('string');
      expect(result).toContain('[blocked]');
      expect(result).toContain('email__send_email');
    });

    it('allows MCP tools with read-only suffixes through unchanged', async () => {
      // Tool names that END with a recognized read-only suffix.
      // The READONLY_SUFFIX_RE uses (?:^|_) so it matches both bare-verb names
      // (e.g. "server__search" — verb directly after "__") and underscore-prefixed
      // names (e.g. "drive__files_read" — verb after an extra underscore).
      // Note: "email__list_emails" does NOT qualify — it ends with "_emails", not "_list".
      const mcpTools = {
        'contacts__search': makeMcpTool('contacts__search'),          // bare verb after __
        'drive__files_read': makeMcpTool('drive__files_read'),        // verb after extra _
        'calendar__events_get': makeMcpTool('calendar__events_get'),  // verb after extra _
        'db__query': makeMcpTool('db__query'),                        // bare verb after __
        'api__lookup': makeMcpTool('api__lookup'),                    // bare verb after __
        'files__find': makeMcpTool('files__find'),                    // bare verb after __
        'email__list': makeMcpTool('email__list'),                    // bare verb after __
      };
      const { filterMcpTools } = resolveCronPermissions({ toolMode: 'read-only' });
      const filtered = filterMcpTools(mcpTools);

      // Each read-only tool should be the same object reference (unmodified)
      for (const name of Object.keys(mcpTools)) {
        expect(filtered[name]).toBe(mcpTools[name]);
      }
    });

    it('passes non-MCP built-in tools through unchanged', async () => {
      const builtinTools = {
        shell: makeMcpTool('shell'),
        memory: makeMcpTool('memory'),
      };
      const { filterMcpTools } = resolveCronPermissions({ toolMode: 'read-only' });
      const filtered = filterMcpTools(builtinTools);

      expect(filtered['shell']).toBe(builtinTools['shell']);
      expect(filtered['memory']).toBe(builtinTools['memory']);
    });
  });

  // -------------------------------------------------------------------------
  // (c) skipPermissions: true — allows everything unconditionally
  // -------------------------------------------------------------------------
  describe('skipPermissions: true', () => {
    it('allows dangerous shell commands', async () => {
      const { confirmDangerous } = resolveCronPermissions({ skipPermissions: true });
      const allowed = await confirmDangerous('rm -rf /important');
      expect(allowed).toBe(true);
    });

    it('passes MCP write tools through unchanged', async () => {
      const mcpTools = {
        'email__send_email': makeMcpTool('email__send_email'),
        'github__create_issue': makeMcpTool('github__create_issue'),
      };
      const { filterMcpTools } = resolveCronPermissions({ skipPermissions: true });
      const filtered = filterMcpTools(mcpTools);

      expect(filtered['email__send_email']).toBe(mcpTools['email__send_email']);
      expect(filtered['github__create_issue']).toBe(mcpTools['github__create_issue']);
    });

    it('overrides toolMode: read-only', async () => {
      const mcpTools = {
        'email__send_email': makeMcpTool('email__send_email'),
      };
      const { confirmDangerous, filterMcpTools } = resolveCronPermissions({
        toolMode: 'read-only',
        skipPermissions: true,
      });

      // Dangerous shell should be allowed
      expect(await confirmDangerous('rm -rf /')).toBe(true);
      // Write MCP tool should pass through unchanged
      const filtered = filterMcpTools(mcpTools);
      expect(filtered['email__send_email']).toBe(mcpTools['email__send_email']);
    });
  });

  // -------------------------------------------------------------------------
  // (d) confirmMode: off — allow dangerous shell even without skipPermissions
  // -------------------------------------------------------------------------
  describe('confirmMode: off', () => {
    it('allows dangerous shell commands', async () => {
      const { confirmDangerous } = resolveCronPermissions({ confirmMode: 'off' });
      const allowed = await confirmDangerous('rm -rf /tmp/something');
      expect(allowed).toBe(true);
    });

    it('passes MCP tools through unchanged when toolMode is write (default)', async () => {
      const mcpTools = {
        'email__send_email': makeMcpTool('email__send_email'),
      };
      const { filterMcpTools } = resolveCronPermissions({ confirmMode: 'off' });
      const filtered = filterMcpTools(mcpTools);
      expect(filtered['email__send_email']).toBe(mcpTools['email__send_email']);
    });

    // Regression test for bug: confirmMode:'off' must NOT bypass toolMode:'read-only' MCP filter.
    // The two axes are orthogonal — confirmMode controls shell danger gate; toolMode controls MCP gate.
    it('still enforces toolMode:read-only MCP filter even when confirmMode is off', async () => {
      const mcpTools = {
        'email__send_email': makeMcpTool('email__send_email'),  // write tool — should be blocked
        'contacts__search': makeMcpTool('contacts__search'),    // read-only tool — should pass
      };
      const { confirmDangerous, filterMcpTools } = resolveCronPermissions({
        confirmMode: 'off',
        toolMode: 'read-only',
      });

      // Shell danger gate: off → dangerous commands allowed
      expect(await confirmDangerous('rm -rf /')).toBe(true);

      // MCP write gate: read-only → write MCP tools blocked despite confirmMode:'off'
      const filtered = filterMcpTools(mcpTools);
      expect(filtered['email__send_email']).not.toBe(mcpTools['email__send_email']);
      const result = await filtered['email__send_email'].execute({});
      expect(result).toContain('[blocked]');

      // Read-only MCP tools still pass through
      expect(filtered['contacts__search']).toBe(mcpTools['contacts__search']);
    });
  });

  // -------------------------------------------------------------------------
  // (e) Regex correctness — READONLY_SUFFIX_RE shared with reference-tool-lookup
  // -------------------------------------------------------------------------
  describe('read-only suffix matching (READONLY_SUFFIX_RE)', () => {
    it('allows tool where the verb appears directly after __ (no extra underscore)', async () => {
      // e.g. "server__search" — verb "search" directly after "__", matched by (?:^|_)
      const mcpTools = {
        'server__search': makeMcpTool('server__search'),
        'server__list': makeMcpTool('server__list'),
        'server__get': makeMcpTool('server__get'),
      };
      const { filterMcpTools } = resolveCronPermissions({ toolMode: 'read-only' });
      const filtered = filterMcpTools(mcpTools);

      for (const name of Object.keys(mcpTools)) {
        expect(filtered[name]).toBe(mcpTools[name]);
      }
    });

    it('blocks tool whose name contains a read-only verb in the middle but not at the end', async () => {
      // e.g. "email__list_emails" — "_list" is NOT at the end; ends with "_emails"
      const mcpTools = {
        'email__list_emails': makeMcpTool('email__list_emails'),
        'contacts__search_results': makeMcpTool('contacts__search_results'),
      };
      const { filterMcpTools } = resolveCronPermissions({ toolMode: 'read-only' });
      const filtered = filterMcpTools(mcpTools);

      // These should be stubbed because they don't end with a read-only verb
      for (const name of Object.keys(mcpTools)) {
        expect(filtered[name]).not.toBe(mcpTools[name]);
        const result = await filtered[name].execute({});
        expect(result).toContain('[blocked]');
      }
    });
  });
});
