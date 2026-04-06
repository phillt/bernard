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
const mockCompactHistory = vi.fn();
const mockSetAlertContext = vi.fn();
const mockGetStepLimitHit = vi.fn(() => null);

vi.mock('./agent.js', () => ({
  Agent: vi.fn(() => ({
    clearHistory: mockClearHistory,
    getHistory: mockGetHistory,
    setSpinnerStats: mockSetSpinnerStats,
    processInput: mockProcessInput,
    abort: mockAbort,
    getLastRAGResults: mockGetLastRAGResults,
    compactHistory: mockCompactHistory,
    setAlertContext: mockSetAlertContext,
    getStepLimitHit: mockGetStepLimitHit,
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
const mockHistorySave = vi.fn();
vi.mock('./history.js', () => ({
  HistoryStore: vi.fn(() => ({
    load: vi.fn(() => []),
    save: mockHistorySave,
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
  formatTokenCount: (n: number) => String(n),
}));

vi.mock('./providers/index.js', () => ({
  getModel: vi.fn(() => ({ modelId: 'mock' })),
}));

vi.mock('./config.js', () => ({
  PROVIDER_MODELS: { anthropic: ['claude-sonnet-4-5-20250929'] },
  getAvailableProviders: vi.fn(() => ['anthropic']),
  getDefaultModel: vi.fn(() => 'claude-sonnet-4-5-20250929'),
  savePreferences: vi.fn(),
  loadPreferences: vi.fn(() => ({})),
  OPTIONS_REGISTRY: {},
  saveOption: vi.fn(),
  normalizeThreshold: vi.fn((v: number) => (v > 1 ? v / 100 : Math.max(0, Math.min(1, v)))),
}));

vi.mock('./theme.js', () => ({
  getTheme: vi.fn(() => ({
    ansi: { prompt: '', reset: '', warning: '', hintCmd: '', hintDesc: '' },
    text: (s: string) => s,
    muted: (s: string) => s,
    warning: (s: string) => s,
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

vi.mock('./routines.js', () => ({
  RoutineStore: vi.fn(() => ({
    list: vi.fn(() => []),
    get: vi.fn(),
  })),
}));

const mockSpecialistCreate = vi.fn();
vi.mock('./specialists.js', () => ({
  SpecialistStore: vi.fn(() => ({
    list: vi.fn(() => []),
    get: vi.fn(),
    getSummaries: vi.fn(() => []),
    create: mockSpecialistCreate,
  })),
}));

const mockListPending = vi.fn(() => []);
const mockAcknowledge = vi.fn(() => true);
const mockPruneOld = vi.fn(() => 0);
const mockCandidateCreate = vi.fn();
const mockCandidateUpdateStatus = vi.fn(() => true);

vi.mock('./specialist-candidates.js', () => ({
  CandidateStore: vi.fn(() => ({
    listPending: mockListPending,
    acknowledge: mockAcknowledge,
    pruneOld: mockPruneOld,
    reconcileSaved: vi.fn(() => 0),
    create: mockCandidateCreate,
    updateStatus: mockCandidateUpdateStatus,
    list: vi.fn(() => []),
  })),
  MAX_PENDING_CANDIDATES: 10,
}));

vi.mock('./specialist-detector.js', () => ({
  detectSpecialistCandidate: vi.fn().mockResolvedValue(null),
}));

// ── Helpers ────────────────────────────────────────────

import type { BernardConfig } from './config.js';

function makeConfig(overrides?: Partial<BernardConfig>): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    maxSteps: 25,
    ragEnabled: false,
    theme: 'bernard',
    criticMode: false,
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
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

describe('REPL /compact command', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    rlEmitter = makeRl();
    vi.spyOn(console, 'clear').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints info and re-prompts when history is too short', async () => {
    mockGetHistory.mockReturnValue([]);
    const { startRepl } = await import('./repl.js');

    const replPromise = startRepl(makeConfig());
    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    typeLine('/compact');

    await vi.waitFor(() => {
      expect(mockPrintInfo).toHaveBeenCalledWith('Not enough conversation to compact.');
    });
    expect(mockCompactHistory).not.toHaveBeenCalled();

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });

  it('prints nothing-to-compact when compactHistory returns compacted: false', async () => {
    mockGetHistory.mockReturnValue([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    mockCompactHistory.mockResolvedValue({
      compacted: false,
      tokensBefore: 500,
      tokensAfter: 500,
    });
    const { startRepl } = await import('./repl.js');

    const replPromise = startRepl(makeConfig());
    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    typeLine('/compact');

    await vi.waitFor(() => {
      expect(mockPrintInfo).toHaveBeenCalledWith(
        'Nothing to compact — conversation is already short enough.',
      );
    });

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });

  it('prints reduction message and saves history on successful compaction', async () => {
    mockGetHistory.mockReturnValue([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    mockCompactHistory.mockResolvedValue({
      compacted: true,
      tokensBefore: 5000,
      tokensAfter: 1000,
    });
    const { startRepl } = await import('./repl.js');

    const replPromise = startRepl(makeConfig());
    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    typeLine('/compact');

    await vi.waitFor(() => {
      expect(mockPrintInfo).toHaveBeenCalledWith('Compacted: ~5000 → ~1000 tokens (80% reduction)');
    });
    expect(mockStopSpinner).toHaveBeenCalled();
    expect(mockHistorySave).toHaveBeenCalled();

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });

  it('calls printError when compactHistory throws', async () => {
    mockGetHistory.mockReturnValue([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    mockCompactHistory.mockRejectedValue(new Error('API down'));
    const { startRepl } = await import('./repl.js');

    const replPromise = startRepl(makeConfig());
    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    typeLine('/compact');

    await vi.waitFor(() => {
      expect(mockPrintError).toHaveBeenCalledWith('Compaction failed: API down');
    });

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });
});

describe('REPL /candidates command', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    rlEmitter = makeRl();
    vi.spyOn(console, 'clear').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints "No pending" when no candidates exist', async () => {
    mockListPending.mockReturnValue([]);
    const { startRepl } = await import('./repl.js');

    const replPromise = startRepl(makeConfig());
    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    typeLine('/candidates');

    await vi.waitFor(() => {
      expect(mockPrintInfo).toHaveBeenCalledWith('No pending specialist suggestions.');
    });

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });

  it('displays candidates and acknowledges them', async () => {
    const fakeCandidates = [
      {
        id: 'c1',
        draftId: 'code-review',
        name: 'Code Review',
        description: 'Reviews pull requests',
        systemPrompt: 'You are a code reviewer.',
        guidelines: [],
        confidence: 0.85,
        reasoning: 'Frequent code review requests',
        detectedAt: '2026-03-01T00:00:00.000Z',
        source: 'exit' as const,
        acknowledged: false,
        status: 'pending' as const,
      },
    ];
    mockListPending.mockReturnValue(fakeCandidates);
    const { startRepl } = await import('./repl.js');

    const replPromise = startRepl(makeConfig());
    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    typeLine('/candidates');

    await vi.waitFor(() => {
      expect(mockPrintInfo).toHaveBeenCalledWith(
        expect.stringContaining('Specialist Suggestions (1)'),
      );
    });

    // Verify candidate details printed
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Code Review'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('code-review'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('85%'));
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Frequent code review requests'),
    );

    // Verify acknowledge called for each candidate
    expect(mockAcknowledge).toHaveBeenCalledWith('c1');

    // Verify agent context injection
    expect(mockSetAlertContext).toHaveBeenCalledWith(expect.stringContaining('Code Review'));

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });

  it('re-prompts after displaying candidates', async () => {
    mockListPending.mockReturnValue([]);
    const { startRepl } = await import('./repl.js');

    const replPromise = startRepl(makeConfig());
    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    const promptCountBefore = rlEmitter.prompt.mock.calls.length;

    typeLine('/candidates');

    await vi.waitFor(() => {
      expect(rlEmitter.prompt.mock.calls.length).toBeGreaterThan(promptCountBefore);
    });

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });
});

describe('REPL /create-task command', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    rlEmitter = makeRl();
    vi.spyOn(console, 'clear').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls agent.processInput with task-prefix instructions', async () => {
    mockProcessInput.mockResolvedValue(undefined);
    const { startRepl } = await import('./repl.js');

    const replPromise = startRepl(makeConfig());
    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    typeLine('/create-task');

    await vi.waitFor(() => {
      expect(mockProcessInput).toHaveBeenCalledWith(expect.stringContaining('task-'));
    });

    // Verify the message contains task-specific instructions
    const callArg = mockProcessInput.mock.calls[0][0] as string;
    expect(callArg).toContain('ID MUST start with "task-"');
    expect(callArg).toContain('saved task');

    // Verify history is saved after processing
    expect(mockHistorySave).toHaveBeenCalled();

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });

  it('re-prompts after create-task completes', async () => {
    mockProcessInput.mockResolvedValue(undefined);
    const { startRepl } = await import('./repl.js');

    const replPromise = startRepl(makeConfig());
    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    const promptCountBefore = rlEmitter.prompt.mock.calls.length;

    typeLine('/create-task');

    await vi.waitFor(() => {
      expect(rlEmitter.prompt.mock.calls.length).toBeGreaterThan(promptCountBefore);
    });

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });

  it('handles errors from processInput gracefully', async () => {
    mockProcessInput.mockRejectedValue(new Error('API error'));
    const { startRepl } = await import('./repl.js');

    const replPromise = startRepl(makeConfig());
    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    typeLine('/create-task');

    await vi.waitFor(() => {
      expect(mockPrintError).toHaveBeenCalledWith('API error');
    });

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });
});

describe('REPL step-limit doubling prompt', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    rlEmitter = makeRl();
    vi.spyOn(console, 'clear').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prompts to double loop limit when step limit is hit and doubles on "y"', async () => {
    mockProcessInput.mockResolvedValue(undefined);
    mockGetStepLimitHit.mockReturnValue({ currentLimit: 25, hitCount: 1 });

    const { startRepl } = await import('./repl.js');
    const config = makeConfig({ maxSteps: 25 });
    const replPromise = startRepl(config);

    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    // Type a normal message to trigger processInput
    typeLine('do something complex');

    // Wait for rl.question to be called with the doubling prompt
    await vi.waitFor(() => {
      expect(rlEmitter.question).toHaveBeenCalledWith(
        expect.stringContaining('50'),
        expect.any(Function),
      );
    });

    // Simulate user answering "y"
    const questionCallback = rlEmitter.question.mock.calls[0][1] as (answer: string) => void;
    questionCallback('y');

    // Config should now be doubled
    expect(config.maxSteps).toBe(50);
    expect(mockPrintInfo).toHaveBeenCalledWith('Loop limit doubled to 50 for this session.');

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });

  it('does not double when user answers "n"', async () => {
    mockProcessInput.mockResolvedValue(undefined);
    mockGetStepLimitHit.mockReturnValue({ currentLimit: 25, hitCount: 1 });

    const { startRepl } = await import('./repl.js');
    const config = makeConfig({ maxSteps: 25 });
    const replPromise = startRepl(config);

    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    typeLine('do something complex');

    await vi.waitFor(() => {
      expect(rlEmitter.question).toHaveBeenCalled();
    });

    const questionCallback = rlEmitter.question.mock.calls[0][1] as (answer: string) => void;
    questionCallback('n');

    // Config should remain unchanged
    expect(config.maxSteps).toBe(25);

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });

  it('includes permanent tip when hitCount >= 2', async () => {
    mockProcessInput.mockResolvedValue(undefined);
    mockGetStepLimitHit.mockReturnValue({ currentLimit: 25, hitCount: 2 });

    const { startRepl } = await import('./repl.js');
    const replPromise = startRepl(makeConfig());

    await vi.waitFor(() => {
      expect(rlEmitter.prompt).toHaveBeenCalled();
    });

    typeLine('do something');

    await vi.waitFor(() => {
      expect(rlEmitter.question).toHaveBeenCalledWith(
        expect.stringContaining('/options max-steps'),
        expect.any(Function),
      );
    });

    // Answer to prevent hanging
    const questionCallback = rlEmitter.question.mock.calls[0][1] as (answer: string) => void;
    questionCallback('n');

    rlEmitter.emit('close');
    await replPromise.catch(() => {});
  });
});
