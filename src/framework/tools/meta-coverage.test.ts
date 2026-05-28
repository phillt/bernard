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

describe('tool meta coverage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('every tool returned by createTools() declares the required meta fields', async () => {
    const { createTools } = await import('../../tools/index.js');
    const tools = createTools(
      { shellTimeout: 10_000, confirmDangerous: async () => false },
      // Cast: the mocked MemoryStore satisfies the structural shape used here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new (await import('../../memory.js')).MemoryStore() as any,
    );

    const missing: string[] = [];
    const incomplete: string[] = [];
    for (const [name, tool] of Object.entries(tools)) {
      if (!tool || typeof tool !== 'object') continue;
      const meta = readToolMeta(tool);
      if (!meta) {
        missing.push(name);
        continue;
      }
      // Every tool must classify itself by determinism and side effect so the
      // cache layer and policy decisions can reason about it.
      if (meta.deterministic === undefined && meta.sideEffect === undefined) {
        incomplete.push(name);
      }
    }

    expect(missing, `Tools missing __bernardMeta: ${missing.join(', ')}`).toEqual([]);
    expect(incomplete, `Tools missing deterministic/sideEffect: ${incomplete.join(', ')}`).toEqual(
      [],
    );
  });
});
