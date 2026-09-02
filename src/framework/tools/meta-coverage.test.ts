import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readToolMeta } from './adapter.js';

// Mock heavyweight stores so createTools() can run without touching disk or
// spawning subprocesses. Each mock matches the minimal surface area used by
// the corresponding tool factory at construction time.
vi.mock('../../memory.js', () => ({
  MemoryStore: class {
    list() {
      return [];
    }
    get() {
      return undefined;
    }
    set() {}
    delete() {}
    listScratch() {
      return [];
    }
    getScratch() {
      return undefined;
    }
    setScratch() {}
    deleteScratch() {}
    clearScratch() {}
  },
}));

vi.mock('../../routines.js', () => ({
  RoutineStore: class {
    list() {
      return [];
    }
    get() {
      return undefined;
    }
  },
}));

vi.mock('../../specialists.js', () => ({
  SpecialistStore: class {
    list() {
      return [];
    }
    get() {
      return undefined;
    }
  },
}));

vi.mock('../../specialist-candidates.js', () => ({
  CandidateStore: class {
    listPending() {
      return [];
    }
  },
}));

vi.mock('../../cron/store.js', () => ({
  CronStore: class {
    loadJobs() {
      return [];
    }
    listAlerts() {
      return [];
    }
    getJob() {
      return undefined;
    }
  },
}));

vi.mock('../../cron/log-store.js', () => ({
  CronLogStore: class {
    getEntries() {
      return [];
    }
    getEntryCount() {
      return 0;
    }
    getEntry() {
      return undefined;
    }
    deleteJobLogs() {
      return false;
    }
    rotate() {}
  },
}));

vi.mock('../../cron/notes-store.js', () => ({
  CronNotesStore: class {
    read() {
      return { entries: [] };
    }
    listJobIds() {
      return [];
    }
    append() {
      return { total: 0 };
    }
    entriesForRun() {
      return [];
    }
  },
  MAX_NOTE_LENGTH: 2000,
}));

vi.mock('../../cron/client.js', () => ({
  isDaemonRunning: () => false,
  startDaemon: vi.fn(),
  stopDaemon: vi.fn(),
}));

vi.mock('../../cron/runner.js', () => ({
  runJob: vi.fn(),
}));

vi.mock('../../mcp.js', () => ({
  listMCPServers: () => [],
  addMCPServer: vi.fn(),
  removeMCPServer: vi.fn(),
  getMCPServer: () => undefined,
  addMCPUrlServer: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  debugLog: vi.fn(),
}));

// Minimal ToolProfileStore stand-in for `augmentTools`. The wrapper only
// touches the store on tool execution; meta inspection at registry
// construction time doesn't read it, so an inert shape suffices.
const fakeProfileStore = {
  get: () => undefined,
  recordBadExample: () => {},
  patchLastBadWithFix: () => {},
};

function checkMetaCoverage(tools: Record<string, unknown>): {
  missing: string[];
  incomplete: string[];
} {
  const missing: string[] = [];
  const incomplete: string[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || typeof tool !== 'object') continue;
    const meta = readToolMeta(tool);
    if (!meta) {
      missing.push(name);
      continue;
    }
    // Both fields are required so the cache layer and policy decisions can
    // reason about the tool without falling back to "unknown" defaults.
    if (meta.deterministic === undefined || meta.sideEffect === undefined) {
      incomplete.push(name);
    }
  }
  return { missing, incomplete };
}

describe('tool meta coverage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('every tool returned by createTools() declares the required meta fields', async () => {
    const { createTools } = await import('../../tools/index.js');
    const tools = createTools(
      { shellTimeout: 10_000, confirmDangerous: async () => false },
      // Cast: the mocked MemoryStore satisfies the structural shape used here.

      new (await import('../../memory.js')).MemoryStore() as any,
    );

    const { missing, incomplete } = checkMetaCoverage(tools);
    expect(missing, `Tools missing __bernardMeta: ${missing.join(', ')}`).toEqual([]);
    expect(incomplete, `Tools missing deterministic/sideEffect: ${incomplete.join(', ')}`).toEqual(
      [],
    );
  });

  /**
   * `WRITE_PATH_TOOLS` (#340) is a hand-maintained name set, and its
   * incompleteness is silent and **fail-open**: a fourth path-taking write
   * tool, or `file_write`'s `path` argument being renamed, ships unscoped with
   * every other test green — including the integration test, which proves the
   * two listed names work but nothing about the set being closed.
   *
   * `FILE_TOOLS`' incompleteness is at least user-visible (a missing entry
   * loses path-scoped grants and the user sees an unexpected prompt). This one
   * would only ever be noticed by the write it failed to stop, so the
   * "declared beside `FILE_TOOLS` so the two cannot drift" comment gets a test
   * rather than a reader's good intentions.
   */
  it('every write tool taking a `path` argument is in WRITE_PATH_TOOLS', async () => {
    const { createTools } = await import('../../tools/index.js');
    const { WRITE_PATH_TOOLS } = await import('../../permissions/matchers.js');
    const tools = createTools(
      { shellTimeout: 10_000, confirmDangerous: async () => false },
      new (await import('../../memory.js')).MemoryStore() as any,
    );

    const unscoped: string[] = [];
    for (const [name, def] of Object.entries(tools)) {
      const meta = readToolMeta(def);
      if (!meta || (meta.kind !== 'write' && meta.kind !== 'dangerous')) continue;
      // `parameters` is the zod schema the model is shown; a `path` key on it
      // is what the gate reads off `args`.
      const shape = (def as { parameters?: { shape?: Record<string, unknown> } })?.parameters?.shape;
      if (!shape || !('path' in shape)) continue;
      if (!WRITE_PATH_TOOLS.has(name)) unscoped.push(name);
    }

    expect(
      unscoped,
      `Write tools with a \`path\` argument missing from WRITE_PATH_TOOLS (they would write ` +
        `anywhere in an unattended run): ${unscoped.join(', ')}`,
    ).toEqual([]);
  });

  it('meta survives augmentTools — non-enumerable __bernardMeta is re-attached after the spread', async () => {
    const { createTools } = await import('../../tools/index.js');
    const { augmentTools } = await import('../../tools/augment.js');
    const tools = createTools(
      { shellTimeout: 10_000, confirmDangerous: async () => false },

      new (await import('../../memory.js')).MemoryStore() as any,
    );

    const augmented = augmentTools(tools, fakeProfileStore as any);

    const { missing } = checkMetaCoverage(augmented);
    expect(
      missing,
      `Tools that lost __bernardMeta during augmentTools spread: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every tool the cron agent registers declares the required meta fields', async () => {
    const { cronDefinition } = await import('../agents/cron.js');
    const memory = new (await import('../../memory.js')).MemoryStore();
    const cronStore = new (await import('../../cron/store.js')).CronStore();
    const notesStore = new (await import('../../cron/notes-store.js')).CronNotesStore();
    const ctx = {
      stores: { memory },
      config: { shellTimeout: 10_000, maxSteps: 20 },
      // Cron now takes MCP from the centrally-resolved surface (#315) rather
      // than its own input, so the context needs a (empty) MCP snapshot.
      mcp: { tools: {}, serverNames: [], serverTools: {} },
    } as any;
    const input = {
      job: { id: 'j1', name: 'test', prompt: 'noop', enabled: true },
      runId: 'r1',
      steps: [],
      store: cronStore,
      notesStore,
      log: () => {},
      serverNames: [],
    } as any;
    const { resolveToolSurface } = await import('../agents/tool-surface.js');
    const tools = cronDefinition.tools(ctx, input, resolveToolSurface(ctx, cronDefinition));

    const { missing, incomplete } = checkMetaCoverage(tools);
    expect(missing, `Cron tools missing __bernardMeta: ${missing.join(', ')}`).toEqual([]);
    expect(
      incomplete,
      `Cron tools missing deterministic/sideEffect: ${incomplete.join(', ')}`,
    ).toEqual([]);
  });
});
