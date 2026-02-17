import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Mocks ──────────────────────────────────────────────

// Controllable readline interface
let rlEmitter: EventEmitter & {
  setPrompt: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  question: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: (...args: any[]) => any;
  removeListener: (...args: any[]) => any;
};

function makeRl() {
  const emitter = new EventEmitter() as any;
  emitter.setPrompt = vi.fn();
  emitter.prompt = vi.fn();
  emitter.question = vi.fn();
  emitter.close = vi.fn();
  emitter.line = '';
  return emitter;
}

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => rlEmitter),
}));

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}));

const mockClearHistory = vi.fn();
const mockGetHistory = vi.fn(() => []);
const mockSetSpinnerStats = vi.fn();
const mockProcessInput = vi.fn();
const mockAbort = vi.fn();
const mockGetLastRAGResults = vi.fn(() => []);

vi.mock('./agent.js', () => ({
  Agent: vi.fn(() => ({
    clearHistory: mockClearHistory,
    getHistory: mockGetHistory,
    setSpinnerStats: mockSetSpinnerStats,
    processInput: mockProcessInput,
    abort: mockAbort,
    getLastRAGResults: mockGetLastRAGResults,
  })),
}));

vi.mock('./memory.js', () => ({
  MemoryStore: vi.fn(() => ({
    listMemory: vi.fn(() => []),
    listScratch: vi.fn(() => []),
    writeScratch: vi.fn(),
    readScratch: vi.fn(),
  })),
}));

vi.mock('./rag.js', () => ({
  RAGStore: vi.fn(() => ({
    search: vi.fn().mockResolvedValue([]),
    addFacts: vi.fn(),
    count: vi.fn(() => 0),
  })),
}));

const mockMCPConnect = vi.fn().mockResolvedValue(undefined);
vi.mock('./mcp.js', () => ({
  MCPManager: vi.fn(() => ({
    connect: mockMCPConnect,
    getServerStatuses: vi.fn(() => []),
    getTools: vi.fn(() => ({})),
    getConnectedServerNames: vi.fn(() => []),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

const mockHistoryClear = vi.fn();
vi.mock('./history.js', () => ({
  HistoryStore: vi.fn(() => ({
    load: vi.fn(() => []),
    save: vi.fn(),
    clear: mockHistoryClear,
  })),
}));

vi.mock('./context.js', () => ({
  serializeMessages: vi.fn(() => ''),
}));

const mockPrintInfo = vi.fn();
const mockPrintWelcome = vi.fn();
const mockPrintHelp = vi.fn();
const mockPrintError = vi.fn();
const mockPrintConversationReplay = vi.fn();
const mockStartSpinner = vi.fn();
const mockStopSpinner = vi.fn();
const mockBuildSpinnerMessage = vi.fn();

vi.mock('./output.js', () => ({
  printHelp: (...args: any[]) => mockPrintHelp(...args),
  printInfo: (...args: any[]) => mockPrintInfo(...args),
  printError: (...args: any[]) => mockPrintError(...args),
  printWelcome: (...args: any[]) => mockPrintWelcome(...args),
  printConversationReplay: (...args: any[]) => mockPrintConversationReplay(...args),
  startSpinner: (...args: any[]) => mockStartSpinner(...args),
  stopSpinner: (...args: any[]) => mockStopSpinner(...args),
  buildSpinnerMessage: (...args: any[]) => mockBuildSpinnerMessage(...args),
}));

vi.mock('./providers/index.js', () => ({
  getModel: vi.fn(() => ({ modelId: 'mock' })),
}));

vi.mock('./config.js', () => ({
  PROVIDER_MODELS: { anthropic: ['claude-sonnet-4-5-20250929'] },
  getAvailableProviders: vi.fn(() => ['anthropic']),
  getDefaultModel: vi.fn(() => 'claude-sonnet-4-5-20250929'),
  savePreferences: vi.fn(),
  OPTIONS_REGISTRY: {},
  saveOption: vi.fn(),
}));

vi.mock('./theme.js', () => ({
  getTheme: vi.fn(() => ({
    ansi: { prompt: '', reset: '', warning: '', hintCmd: '', hintDesc: '' },
  })),
  setTheme: vi.fn(),
  getThemeKeys: vi.fn(() => []),
  getActiveThemeKey: vi.fn(() => 'bernard'),
  THEMES: {},
}));

vi.mock('./update.js', () => ({
  interactiveUpdate: vi.fn().mockResolvedValue(undefined),
  getLocalVersion: vi.fn(() => '0.3.1'),
}));

vi.mock('./cron/store.js', () => ({
  CronStore: vi.fn(() => ({
    loadJobs: vi.fn(() => []),
    listAlerts: vi.fn(() => []),
  })),
}));

vi.mock('./cron/client.js', () => ({
  isDaemonRunning: vi.fn(() => false),
}));

vi.mock('./domains.js', () => ({
  getDomain: vi.fn((id: string) => ({ name: id, id })),
  getDomainIds: vi.fn(() => []),
}));

// ── Helpers ────────────────────────────────────────────

import type { BernardConfig } from './config.js';

function makeConfig(overrides?: Partial<BernardConfig>): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    ragEnabled: false,
    anthropicApiKey: 'sk-test',
    ...overrides,
  };
}

/**
 * Simulate typing a line into the REPL.
 * After startRepl awaits MCP connect and calls prompt(), we emit a 'line' event.
 * We need a small delay so the REPL's readInput() promise is listening.
 */
function typeLine(text: string): void {
  // readInput sets up rl.on('line', ...) after rl.prompt() is called
  // Use nextTick to ensure the listener is registered
  process.nextTick(() => rlEmitter.emit('line', text));
}

// ── Tests ──────────────────────────────────────────────

describe('REPL /clear command', () => {
  let consoleClearSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    rlEmitter = makeRl();
    consoleClearSpy = vi.spyOn(console, 'clear').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Prevent process.exit from actually exiting (Vitest intercepts it as an error)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('/clear calls console.clear()', async () => {
    const { startRepl } = await import('./repl.js');

    // startRepl is a long-running function, so we don't await it — we
    // just let it set up and then interact with it via rl events.
    const replPromise = startRepl(makeConfig());

    // Wait for MCP connect + initial prompt() to be called
    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    // Type /clear
    typeLine('/clear');

    // Wait for the handler to process and call prompt() again
    await vi.waitFor(() => {
      expect(consoleClearSpy).toHaveBeenCalledTimes(1);
    });

    // Clean up: close the REPL
    rlEmitter.emit('close');
    await replPromise.catch(() => {}); // process.exit will throw in test
  });

  it('/clear calls printWelcome with provider and model', async () => {
    const { startRepl } = await import('./repl.js');
    const config = makeConfig({ provider: 'openai', model: 'gpt-4o' });

    const replPromise = startRepl(config);

    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    typeLine('/clear');

    await vi.waitFor(() => {
      expect(mockPrintWelcome).toHaveBeenCalledWith('openai', 'gpt-4o', '0.3.1');
    });

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });

  it('/clear clears agent history and history store', async () => {
    const { startRepl } = await import('./repl.js');

    const replPromise = startRepl(makeConfig());

    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    typeLine('/clear');

    await vi.waitFor(() => {
      expect(mockClearHistory).toHaveBeenCalledTimes(1);
      expect(mockHistoryClear).toHaveBeenCalledTimes(1);
    });

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });

  it('/clear prints info message after welcome banner', async () => {
    const { startRepl } = await import('./repl.js');

    const replPromise = startRepl(makeConfig());

    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    typeLine('/clear');

    await vi.waitFor(() => {
      expect(mockPrintInfo).toHaveBeenCalledWith('Conversation history and scratch notes cleared.');
    });

    // Verify ordering: printWelcome should be called before printInfo
    const welcomeOrder = mockPrintWelcome.mock.invocationCallOrder[0];
    const infoCalls = mockPrintInfo.mock.invocationCallOrder;
    // Find the specific "cleared" info call
    const clearedCallIndex = mockPrintInfo.mock.calls.findIndex(
      (args) => args[0] === 'Conversation history and scratch notes cleared.',
    );
    const clearedOrder = infoCalls[clearedCallIndex];
    expect(welcomeOrder).toBeLessThan(clearedOrder);

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });

  it('/clear re-prompts for next input', async () => {
    const { startRepl } = await import('./repl.js');

    const replPromise = startRepl(makeConfig());

    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    const promptCountBefore = rlEmitter.prompt.mock.calls.length;

    typeLine('/clear');

    await vi.waitFor(() => {
      expect(rlEmitter.prompt.mock.calls.length).toBeGreaterThan(promptCountBefore);
    });

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });
});
