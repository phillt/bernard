/**
 * App-level integration tests. Covers slash-dispatch shapes that don't
 * require heavy backend wiring:
 *
 *   - pure-toast / info-overlay commands (the dominant shape)
 *   - alert banner + exit routing
 *   - /help overlay mount
 *   - /clear (no --save branch — the --save branch is exercised through
 *     direct unit coverage of `extractDomainFacts` / `serializeMessages`
 *     elsewhere)
 *
 * The wizard- and LLM-driven commands (/agent-options, /profiles,
 * /candidates, /create-routine, /image, /task, etc.) are intentionally
 * **not** exercised here; they require either a full Agent loop, an
 * LLM round-trip, or a mocked profile wizard. Their effect is covered by
 * unit tests on the underlying modules (profiles-wizard, image-loader,
 * candidate-bootstrap, etc.) and the slash strings themselves are
 * smoke-checked via App rendering without crashing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ENTER, ESC, SHIFT_TAB, tick } from './_keys.js';
import stripAnsi from 'strip-ansi';

// ── Module mocks (all hoisted by vitest) ────────────────────────────────

vi.mock('../../reference-resolver.js', () => ({
  resolveReferences: vi.fn(async () => ({ status: 'noop' as const })),
  stripToolResolvableTokens: (s: string) => s,
  shouldSkipResolver: () => true,
}));

vi.mock('../../prompt-rewriter.js', () => ({
  rewritePrompt: vi.fn(async () => ({ status: 'noop' as const })),
}));

vi.mock('../../update.js', () => ({
  getLocalVersion: () => '0.0.0-test',
  interactiveUpdate: vi.fn(async () => {}),
}));

vi.mock('../../candidate-bootstrap.js', () => ({
  buildCandidateContextBlock: () => '',
  promoteCandidate: vi.fn(),
  promotePendingCandidates: vi.fn(() => 0),
}));

vi.mock('../../specialist-detector.js', () => ({
  detectSpecialistCandidate: vi.fn(async () => null),
}));

// Mock extractDomainFacts (but keep serializeMessages, SUMMARIZATION_PROMPT, etc. real).
const mockExtractDomainFacts = vi.fn(async () => []);
vi.mock('../../context.js', async (importActual) => {
  const actual = await importActual<typeof import('../../context.js')>();
  return {
    ...actual,
    extractDomainFacts: (...args: unknown[]) => mockExtractDomainFacts(...args),
  };
});

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(async () => ({ text: '' })),
  };
});

// Stub daemon control so the /cron menu's enable/disable/delete sync never forks
// a real daemon process. CronStore / CronLogStore stay real (they operate on the
// isolated TMP_HOME below).
vi.mock('../../cron/client.js', () => ({
  isDaemonRunning: () => false,
  startDaemon: vi.fn(() => true),
  stopDaemon: vi.fn(() => true),
  getDaemonPid: () => null,
}));

// Isolated XDG home so CronStore / MemoryStore can't see user data.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-app-test-'));
process.env.BERNARD_HOME = TMP_HOME;

// ── Imports under test (after mocks + env) ──────────────────────────────
import { App, buildResumeSeed, type AppStores } from '../App.js';
import { DimensionsProvider } from '../DimensionsContext.js';
import { getInkHandlers } from '../ink-handlers.js';
import type { CoreMessage } from 'ai';
import type { BernardConfig } from '../../config.js';
import type { Agent } from '../../agent.js';
import type { HistoryStore } from '../../history.js';
import type { ProvenanceHistoryStore } from '../../provenance-history.js';
import type { TurnContextStore } from '../../turn-context.js';
import type { MemoryStore } from '../../memory.js';
import type { RoutineStore } from '../../routines.js';
import type { SpecialistStore } from '../../specialists.js';
import type { CandidateStore } from '../../specialist-candidates.js';
import type { RAGStore } from '../../rag.js';
import { promoteCandidate } from '../../candidate-bootstrap.js';
import { CronStore } from '../../cron/store.js';
import { generateText } from 'ai';
import stripAnsi from 'strip-ansi';

// ── Stub harness ────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<BernardConfig> = {}): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
    shellTimeout: 30_000,
    tokenWindow: 0,
    maxSteps: 25,
    coordinatorMode: 'off',
    modelMode: 'balanced',
    subagentResultMaxChars: 4000,
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    correctionEnabled: false,
    promptRewriter: false,
    referenceLookup: false,
    confirmMode: 'auto',
    toolMode: 'write',
    maxConcurrentAgents: 4,
    responseStyle: 'default',
    conciseMode: false,
    toolDetails: false,
    ragEnabled: false,
    theme: 'bernard',
    customProviders: {},
    ...overrides,
  } as unknown as BernardConfig;
}

interface AgentSpy {
  processInput: ReturnType<typeof vi.fn>;
  clearHistory: ReturnType<typeof vi.fn>;
  compactHistory: ReturnType<typeof vi.fn>;
}

function makeAgent(
  spy: Partial<AgentSpy> = {},
  history: CoreMessage[] = [],
  // Optional holder so a test can REPLACE the history array reference mid-turn
  // (what Agent.processInput does on auto-compression). When omitted, history is
  // a stable in-place array.
  holder?: { current: CoreMessage[] },
): Agent {
  const box = holder ?? { current: history };
  const stubs: AgentSpy = {
    processInput: vi.fn(async () => {}),
    clearHistory: vi.fn(() => {
      box.current.length = 0;
    }),
    compactHistory: vi.fn(async () => ({ compacted: false })),
    ...spy,
  };
  return {
    getHistory: () => box.current,
    clearHistory: stubs.clearHistory,
    compactHistory: stubs.compactHistory,
    processInput: stubs.processInput,
    getLastPolicyDecision: () => null,
    getLastRAGResults: () => [],
    getTurnProvenance: () => [],
    getTurnContext: () => [],
    getContext: () => ({ provenance: { clear: () => {}, list: () => [] } }),
    getCorrectionStore: () => ({ listPending: () => [] }),
    getPlanSnapshot: () => [],
    subscribeToPlanStore: () => () => {},
    getLastUserInput: () => null,
    getLastResolvedReferences: () => [],
    getLastVerification: () => null,
    abort: () => {},
    setAlertContext: () => {},
    setSpinnerStats: () => {},
    beginTurnStats: () => {},
    finalizeTurnStats: () => undefined,
    spinnerStats: null,
  } as unknown as Agent;
}

function makeStores(overrides: Partial<AppStores> = {}): AppStores {
  return {
    memory: {
      listMemory: () => [],
      listScratch: () => [],
      writeMemory: vi.fn(),
      readMemory: () => '',
      hasMemory: () => false,
      readScratch: () => '',
      hasScratch: () => false,
      writeScratch: vi.fn(),
    } as unknown as MemoryStore,
    routines: {
      get: () => undefined,
      list: () => [],
      delete: vi.fn(() => true),
    } as unknown as RoutineStore,
    specialists: {
      list: () => [],
      get: () => undefined,
      update: vi.fn(),
      delete: vi.fn(() => true),
    } as unknown as SpecialistStore,
    candidates: {
      listPending: () => [],
      list: () => [],
      acknowledge: vi.fn(),
      updateStatus: vi.fn(() => true),
    } as unknown as CandidateStore,
    ...overrides,
  };
}

interface HarnessOptions {
  agent?: Partial<AgentSpy>;
  alertBanner?: string;
  config?: Partial<BernardConfig>;
  /** Live history array `getHistory()` returns; mutate it from `processInput`. */
  history?: CoreMessage[];
  /** Holder whose `.current` `getHistory()` returns; swap it to simulate a mid-turn replace. */
  holder?: { current: CoreMessage[] };
  /** Override individual stores (e.g. seed specialists/routines/candidates). */
  stores?: Partial<AppStores>;
  /** Render in full-screen mode (alt buffer) — wraps App in DimensionsProvider. */
  fullScreen?: boolean;
  /** Welcome-splash lines rendered in-tree (full-screen). */
  welcomeLines?: string[];
}

function renderApp(opts: HarnessOptions = {}) {
  const agentSpy: AgentSpy = {
    processInput: vi.fn(async () => {}),
    clearHistory: vi.fn(),
    compactHistory: vi.fn(async () => ({ compacted: false })),
    ...opts.agent,
  };
  const onExit = vi.fn(async () => {});
  const historyStore = {
    clear: vi.fn(),
    save: vi.fn(),
    load: () => [],
  } as unknown as HistoryStore;
  const provenanceHistoryStore = {
    clear: vi.fn(),
    save: vi.fn(),
    load: () => [],
  } as unknown as ProvenanceHistoryStore;
  const turnContextStore = {
    clear: vi.fn(),
    save: vi.fn(),
    load: () => [],
  } as unknown as TurnContextStore;
  const sessionToolAllowlist = new Set<string>();
  const stores = makeStores(opts.stores);
  const config = makeConfig(opts.config);
  const appEl = createElement(App, {
    agent: makeAgent(agentSpy, opts.history, opts.holder),
    config,
    historyStore,
    provenanceHistoryStore,
    turnContextStore,
    stores,
    sessionToolAllowlist,
    onExit,
    alertBanner: opts.alertBanner,
    fullScreen: opts.fullScreen,
    welcomeLines: opts.welcomeLines,
  });
  // Full-screen reads terminal size via DimensionsProvider, as in production.
  const utils = render(opts.fullScreen ? createElement(DimensionsProvider, null, appEl) : appEl);
  return {
    ...utils,
    agentSpy,
    onExit,
    historyStore,
    provenanceHistoryStore,
    turnContextStore,
    sessionToolAllowlist,
    stores,
    config,
  };
}

async function submit(stdin: { write: (s: string) => void }, text: string) {
  stdin.write(text);
  await tick();
  stdin.write(ENTER);
  await tick(40);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('<App> mount & prompt', () => {
  beforeEach(() => {
    process.env.BERNARD_HOME = TMP_HOME;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the prompt on mount without crashing', async () => {
    const { lastFrame, unmount } = renderApp();
    await tick();
    expect(lastFrame()).toBeDefined();
    unmount();
  });

  it('renders the alertBanner when supplied', async () => {
    const { lastFrame, unmount } = renderApp({ alertBanner: 'CRON_ALERT — job foo failed' });
    await tick();
    expect(lastFrame()).toContain('CRON_ALERT — job foo failed');
    unmount();
  });
});

describe('<App> full-screen layout', () => {
  beforeEach(() => {
    process.env.BERNARD_HOME = TMP_HOME;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('mounts the full-screen frame with the prompt, without crashing', async () => {
    const { lastFrame, unmount } = renderApp({ fullScreen: true });
    await tick();
    // Prompt chevron renders at the bottom of the fixed frame.
    expect(lastFrame()).toContain('›');
    unmount();
  });

  it('renders the welcome splash lines inside the frame (alt buffer hides the normal screen)', async () => {
    const { lastFrame, unmount } = renderApp({
      fullScreen: true,
      welcomeLines: ['── BERNARD ──', 'Version...v9.9.9'],
    });
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('BERNARD');
    expect(frame).toContain('v9.9.9');
    unmount();
  });

  it('replaces the view with the overlay zone when /help opens', async () => {
    const { stdin, lastFrame, unmount } = renderApp({ fullScreen: true });
    await tick();
    await submit(stdin, '/help');
    const frame = lastFrame() ?? '';
    // Help overlay content is shown; the prompt chevron is gone (overlay zone
    // replaces the thread+chrome in full-screen).
    //
    // Asserted on the overlay's footer legend rather than any one command row:
    // the help screen renders ~48 lines into the 24-row full-screen frame and
    // nothing bounds it, so rows overwrite each other and *which* ones survive
    // is a function of the total row count. This used to check for the literal
    // 'help', which passed only because `/help` happened to land on a surviving
    // line — adding one command to the catalogue (#390) shifted the parity and
    // broke it, with the overlay working exactly as before. The footer is the
    // last line rendered, so it is there whatever the row count. (The overflow
    // itself is a separate, pre-existing defect — measured at 44 lines before
    // this change added any commands. Filed as #392.)
    expect(stripAnsi(frame)).toContain('↵/esc/q close');
    expect(frame).not.toContain('›');
    unmount();
  });
});

describe('<App> exit commands', () => {
  beforeEach(() => {
    process.env.BERNARD_HOME = TMP_HOME;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('/exit calls onExit exactly once', async () => {
    const { stdin, onExit, unmount } = renderApp();
    await tick();
    await submit(stdin, '/exit');
    expect(onExit).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('/quit calls onExit exactly once', async () => {
    const { stdin, onExit, unmount } = renderApp();
    await tick();
    await submit(stdin, '/quit');
    expect(onExit).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe('<App> Shift-Tab viewer tabs (#211)', () => {
  beforeEach(() => {
    process.env.BERNARD_HOME = TMP_HOME;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Shift-Tab opens the Status tab, then cycles (and wraps) through the tab menu', async () => {
    const { stdin, lastFrame, unmount } = renderApp();
    await tick();
    // Idle: prompt chrome (HintBar) visible, no viewer/tab menu.
    expect(lastFrame()).toContain('commands');
    expect(lastFrame()).not.toContain('Agent Status');

    // Shift-Tab → Agent Status takes over; both tabs show in the bottom menu,
    // Status marked active. The HintBar chrome is hidden.
    stdin.write(SHIFT_TAB);
    await tick();
    let frame = lastFrame() ?? '';
    expect(frame).toContain('> Agent Status'); // active
    expect(frame).toContain('Sources'); // other tab listed
    expect(frame).not.toContain('> Sources'); // but not active
    expect(frame).toContain('esc close');
    expect(frame).not.toContain('commands');

    // Shift-Tab again → Sources tab active.
    stdin.write(SHIFT_TAB);
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).toContain('> Sources');
    expect(frame).not.toContain('> Agent Status');

    // Shift-Tab again → Prompt & Context tab active.
    stdin.write(SHIFT_TAB);
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).toContain('> Prompt & Context');
    expect(frame).not.toContain('> Sources');

    // Shift-Tab again → Usage & Cost tab active.
    stdin.write(SHIFT_TAB);
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).toContain('> Usage & Cost');
    expect(frame).not.toContain('> Prompt & Context');

    // Shift-Tab once more → wraps back to Status (does not close).
    stdin.write(SHIFT_TAB);
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).toContain('> Agent Status');
    expect(frame).not.toContain('> Usage & Cost');
    expect(frame).not.toContain('commands');
    unmount();
  });

  it('Esc closes the viewer and restores the thread chrome', async () => {
    const { stdin, lastFrame, unmount } = renderApp();
    await tick();
    stdin.write(SHIFT_TAB);
    await tick();
    expect(lastFrame()).toContain('> Agent Status');
    stdin.write(ESC);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Agent Status');
    expect(frame).toContain('commands');
    unmount();
  });
});

describe('<App> pure-toast commands', () => {
  beforeEach(() => {
    process.env.BERNARD_HOME = TMP_HOME;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('/memory flashes a toast when no memories exist', async () => {
    const { stdin, lastFrame, unmount } = renderApp();
    await tick();
    await submit(stdin, '/memory');
    expect(lastFrame()).toContain('No persistent memories stored');
    unmount();
  });

  it('/scratch flashes a toast when no scratch notes exist', async () => {
    const { stdin, lastFrame, unmount } = renderApp();
    await tick();
    await submit(stdin, '/scratch');
    expect(lastFrame()).toContain('No scratch notes in this session');
    unmount();
  });

  it('/mcp flashes a toast when no servers are configured', async () => {
    const { stdin, lastFrame, unmount } = renderApp();
    await tick();
    await submit(stdin, '/mcp');
    expect(lastFrame()).toContain('No MCP servers configured');
    unmount();
  });

  it('/rag flashes a toast when ragEnabled is false', async () => {
    const { stdin, lastFrame, unmount } = renderApp();
    await tick();
    await submit(stdin, '/rag');
    expect(lastFrame()).toContain('RAG is disabled');
    unmount();
  });

  it('/facts flashes a toast when no facts are loaded', async () => {
    const { stdin, lastFrame, unmount } = renderApp();
    await tick();
    await submit(stdin, '/facts');
    expect(lastFrame()).toContain('No RAG facts');
    unmount();
  });

  it('/policy flashes a toast when no decision has been made', async () => {
    const { stdin, lastFrame, unmount } = renderApp();
    await tick();
    await submit(stdin, '/policy');
    expect(lastFrame()).toContain('No policy decision yet');
    unmount();
  });

  it('/compact flashes a toast on a short history', async () => {
    const { stdin, lastFrame, unmount } = renderApp();
    await tick();
    await submit(stdin, '/compact');
    expect(lastFrame()).toContain('Not enough conversation to compact');
    unmount();
  });
});

describe('<App> /help overlay', () => {
  beforeEach(() => {
    process.env.BERNARD_HOME = TMP_HOME;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('/help mounts the HelpOverlay', async () => {
    const { stdin, lastFrame, unmount } = renderApp();
    await tick();
    await submit(stdin, '/help');
    const frame = lastFrame() ?? '';
    // What this test owns is the WIRING — the slash command mounts the
    // overlay. It used to name three commands scattered through the
    // catalogue, which stopped being a statement about App the moment help
    // was windowed to the frame (#392): `/exit` is simply below the fold now.
    // The catalogue itself is asserted against the pure `helpLines()` in
    // `HelpOverlay.test.tsx`, with no renderer at all.
    expect(frame).toContain('Commands');
    expect(frame).toContain('/help');
    expect(stripAnsi(frame)).toContain('↵/esc/q close');
    unmount();
  });
});

describe('<App> /clear', () => {
  beforeEach(() => {
    process.env.BERNARD_HOME = TMP_HOME;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('clears the agent + stores without --save', async () => {
    const { stdin, historyStore, provenanceHistoryStore, agentSpy, lastFrame, unmount } =
      renderApp();
    await tick();
    await submit(stdin, '/clear');
    expect(historyStore.clear).toHaveBeenCalled();
    expect(provenanceHistoryStore.clear).toHaveBeenCalled();
    expect(agentSpy.clearHistory).toHaveBeenCalled();
    expect(lastFrame()).toContain('Conversation history cleared');
    unmount();
  });

  it('rejects bad arguments to /clear with a usage toast', async () => {
    const { stdin, lastFrame, agentSpy, unmount } = renderApp();
    await tick();
    await submit(stdin, '/clear --bogus');
    expect(lastFrame()).toContain('Usage: /clear');
    expect(agentSpy.clearHistory).not.toHaveBeenCalled();
    unmount();
  });

  it('/clear --save skips summarization when history is too short (< 2)', async () => {
    // history defaults to [] in renderApp, so length is 0 < 2
    const { stdin, stores, agentSpy, unmount } = renderApp();
    await tick();
    await submit(stdin, '/clear --save');
    await tick(40);
    // Memory should NOT have been written (too short to summarize)
    expect(stores.memory.writeMemory).not.toHaveBeenCalled();
    // But history is still cleared (the clear path always runs)
    expect(agentSpy.clearHistory).toHaveBeenCalled();
    unmount();
  });
});

describe('<App> /clear --save (#228)', () => {
  beforeEach(() => {
    process.env.BERNARD_HOME = TMP_HOME;
    vi.clearAllMocks();
    // Return no domain facts by default (can override per test).
    mockExtractDomainFacts.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeHistory(): CoreMessage[] {
    return [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
  }

  it('does NOT write a session-summary memory entry, and still clears history', async () => {
    // #307: the prose summary used to be written to `MemoryStore`, where
    // `renderPersistentMemory` injects every file IN FULL on every step — 54 of
    // them had grown to ~44k tokens re-sent per step. The same transcript already
    // reaches RAG as atomic facts via `extractDomainFacts` (the `conversations`
    // domain is itself a conversation summarizer), so the blob was a redundant
    // second copy in a worse shape.
    const history = makeHistory();
    const { stdin, agentSpy, historyStore, stores, unmount } = renderApp({ history });
    await tick();
    await submit(stdin, '/clear --save');
    await tick(80);

    expect(stores.memory.writeMemory).not.toHaveBeenCalled();

    // Clearing is unaffected.
    expect(agentSpy.clearHistory).toHaveBeenCalled();
    expect(historyStore.clear).toHaveBeenCalled();
    unmount();
  });

  it('runs no summarize LLM call — its only consumer was the memory write', async () => {
    // Retiring the write retires the call. Fact extraction still runs; it reads
    // the raw transcript, never the summary.
    const history = makeHistory();
    const { stdin, unmount } = renderApp({ history });
    await tick();
    await submit(stdin, '/clear --save');
    await tick(80);

    expect(generateText).not.toHaveBeenCalled();
    expect(mockExtractDomainFacts).toHaveBeenCalled();
    unmount();
  });

  it('calls addFacts for each domain returned by extractDomainFacts', async () => {
    mockExtractDomainFacts.mockResolvedValue([
      { domain: 'general', facts: ['TypeScript project'] },
      { domain: 'tool-usage', facts: ['npm run build compiles'] },
    ]);

    const mockAddFacts = vi.fn(async () => 1);
    const ragStore = { addFacts: mockAddFacts } as unknown as RAGStore;

    const history = makeHistory();
    const { stdin, unmount } = renderApp({
      history,
      config: { ragEnabled: true },
      stores: { rag: ragStore },
    });
    await tick();
    await submit(stdin, '/clear --save');
    await tick(80);

    expect(mockAddFacts).toHaveBeenCalledWith(['TypeScript project'], 'clear-save', 'general');
    expect(mockAddFacts).toHaveBeenCalledWith(
      ['npm run build compiles'],
      'clear-save',
      'tool-usage',
    );
    unmount();
  });

  it('still clears history and calls addFacts even when some domains reject', async () => {
    // Exercises the failure path: one domain succeeds, one rejects.
    // The warning toast fires but is overwritten by "Conversation history cleared"
    // in the same tick, so we verify the observable side effects instead.
    mockExtractDomainFacts.mockResolvedValue([
      { domain: 'general', facts: ['TypeScript project'] },
      { domain: 'tool-usage', facts: ['npm run build compiles'] },
    ]);

    const mockAddFacts = vi
      .fn()
      .mockResolvedValueOnce(1) // general succeeds
      .mockRejectedValueOnce(new Error('embedding failed')); // tool-usage fails

    const ragStore = { addFacts: mockAddFacts } as unknown as RAGStore;

    const history = makeHistory();
    const { stdin, agentSpy, historyStore, lastFrame, unmount } = renderApp({
      history,
      config: { ragEnabled: true },
      stores: { rag: ragStore },
    });
    await tick();
    await submit(stdin, '/clear --save');
    await tick(80);

    // Both domains were attempted
    expect(mockAddFacts).toHaveBeenCalledTimes(2);
    // History is still cleared even when RAG fails
    expect(agentSpy.clearHistory).toHaveBeenCalled();
    expect(historyStore.clear).toHaveBeenCalled();
    // The final frame shows the "cleared" toast (the warning is transient)
    expect(lastFrame()).toContain('Conversation history cleared');
    unmount();
  });

  it('uses the actual addFacts return value (not input fact count) for storedFacts', async () => {
    // addFacts deduplicates internally and returns how many were actually added.
    // This test ensures we read r.value (not input facts.length).
    // If we were using the input count, facts.length=3 and r.value=1 would
    // both let this path pass silently — but a rejection test above proves
    // the fulfilled branch correctly reads r.value.
    mockExtractDomainFacts.mockResolvedValue([
      { domain: 'general', facts: ['fact one', 'fact two', 'fact three'] },
    ]);

    // Only 1 of 3 facts passes dedup — returns 1, not 3
    const mockAddFacts = vi.fn(async () => 1);
    const ragStore = { addFacts: mockAddFacts } as unknown as RAGStore;

    const history = makeHistory();
    const { stdin, agentSpy, lastFrame, unmount } = renderApp({
      history,
      config: { ragEnabled: true },
      stores: { rag: ragStore },
    });
    await tick();
    await submit(stdin, '/clear --save');
    await tick(80);

    // addFacts was called once (one domain)
    expect(mockAddFacts).toHaveBeenCalledTimes(1);
    // No crash — history still cleared
    expect(agentSpy.clearHistory).toHaveBeenCalled();
    expect(lastFrame()).toContain('Conversation history cleared');
    unmount();
  });
});

describe('<App> Static transcript (#232)', () => {
  beforeEach(() => {
    process.env.BERNARD_HOME = TMP_HOME;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('commits the user then assistant message into the transcript after a turn', async () => {
    // Stateful history: processInput pushes the user + assistant messages the
    // way the real Agent does, so App.commitNewHistory has something to freeze
    // into the <Static> log.
    const history: CoreMessage[] = [];
    const processInput = vi.fn(async (text: string) => {
      history.push({ role: 'user', content: `[2026-01-01T00:00:00+00:00] ${text}` });
      history.push({ role: 'assistant', content: 'committed answer' });
    });
    const { stdin, lastFrame, unmount } = renderApp({ history, agent: { processInput } });
    await tick();
    await submit(stdin, 'render me');
    const frame = lastFrame() ?? '';
    expect(processInput).toHaveBeenCalled();
    expect(frame).toContain('render me');
    expect(frame).toContain('committed answer');
    unmount();
  });

  it('/clear resets the commit boundary so a post-clear turn still commits', async () => {
    // The physical scrollback wipe (`\x1b[3J\x1b[2J\x1b[H`) goes to the real
    // process.stdout, not ink-testing-library's buffer, and Ink's <Static>
    // never un-prints — so a `not.toContain` on the old text isn't observable
    // in this harness (a real terminal clears it). What IS observable, and is
    // the actual regression risk, is that /clear resets committedLenRef to 0
    // so the NEXT turn re-commits from a fresh history without index drift.
    const history: CoreMessage[] = [];
    const processInput = vi.fn(async (text: string) => {
      history.push({ role: 'user', content: `[2026-01-01T00:00:00+00:00] ${text}` });
      history.push({ role: 'assistant', content: `answer for ${text}` });
    });
    const { stdin, lastFrame, agentSpy, unmount } = renderApp({ history, agent: { processInput } });
    await tick();
    await submit(stdin, 'first turn');
    expect(lastFrame() ?? '').toContain('answer for first turn');
    await submit(stdin, '/clear');
    expect(agentSpy.clearHistory).toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('Conversation history cleared');
    // History was emptied by clearHistory(); a new turn must commit cleanly.
    await submit(stdin, 'second turn');
    expect(lastFrame() ?? '').toContain('answer for second turn');
    unmount();
  });

  it('commits the turn output when history is replaced mid-turn by compression (#243)', async () => {
    // Reproduces the Copilot review bug: a length-based commit cursor strands
    // the turn's assistant message when processInput compresses (reassigns) the
    // history array to a SHORTER one mid-turn. Seed a long prior history so the
    // stale cursor (its length after the user push) ends up past the end of the
    // compressed array — the unfixed code would no-op and drop the answer.
    const prior: CoreMessage[] = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `prior ${i}`,
    }));
    const holder = { current: [...prior] };
    const processInput = vi.fn(async (text: string) => {
      // turn start (synchronous, before any await): push the user message onto
      // the current array — this is what the turn-start commit sees.
      holder.current.push({ role: 'user', content: `[2026-01-01T00:00:00+00:00] ${text}` });
      await Promise.resolve();
      // mid-turn auto-compression: replace history with a much shorter array
      // that keeps a summary + the most recent user message, then append the
      // assistant reply (as the real agent loop does).
      holder.current = [
        { role: 'assistant', content: 'context summary' },
        { role: 'user', content: `[2026-01-01T00:00:00+00:00] ${text}` },
        { role: 'assistant', content: 'answer survives compression' },
      ];
    });
    const { stdin, lastFrame, unmount } = renderApp({ holder, agent: { processInput } });
    await tick();
    await submit(stdin, 'trigger compression');
    expect(processInput).toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('answer survives compression');
    unmount();
  });
});

describe('<App> plain-text turn', () => {
  beforeEach(() => {
    process.env.BERNARD_HOME = TMP_HOME;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes non-slash input through agent.processInput', async () => {
    const { stdin, agentSpy, unmount } = renderApp();
    await tick();
    await submit(stdin, 'hello bernard');
    await tick(40);
    expect(agentSpy.processInput).toHaveBeenCalled();
    const firstArg = agentSpy.processInput.mock.calls[0]?.[0];
    expect(firstArg).toBe('hello bernard');
    unmount();
  });

  it('dismisses the alert banner after the first submit', async () => {
    const { stdin, lastFrame, unmount } = renderApp({
      alertBanner: 'CRON_ALERT — job foo',
      agent: { processInput: vi.fn(async () => {}) },
    });
    await tick();
    expect(lastFrame()).toContain('CRON_ALERT — job foo');
    await submit(stdin, 'hi');
    await tick(40);
    expect(lastFrame()).not.toContain('CRON_ALERT — job foo');
    unmount();
  });
});

describe('<App> requestAskUser "Other" dedup (#230)', () => {
  beforeEach(() => {
    process.env.BERNARD_HOME = TMP_HOME;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not append the escape hatch when the model already provided an "Other" choice', async () => {
    const { stdin, lastFrame, unmount } = renderApp();
    await tick();
    const pending = getInkHandlers()!.requestAskUser([
      { question: 'How many kids?', choices: ['1 kid', '2 kids', 'Other'], allowOther: true },
    ]);
    await tick(40);
    const frame = lastFrame()!;
    expect(frame).toContain('How many kids?');
    expect(frame).toContain('3. Other');
    expect(frame).not.toContain('Other (type your own)');
    expect(frame).not.toContain('4.');
    // Selecting the model's "Other" routes to the free-text input.
    stdin.write('3');
    await tick(40);
    expect(lastFrame()).not.toContain('1 kid'); // menu gone → text input
    stdin.write('four kids');
    await tick();
    stdin.write(ENTER);
    await tick(40);
    await expect(pending).resolves.toEqual({ answers: ['four kids'] });
    unmount();
  });

  it('routes a model-provided "Other (I\'ll specify)" variant to free text even with allowOther false', async () => {
    const { stdin, unmount } = renderApp();
    await tick();
    const pending = getInkHandlers()!.requestAskUser([
      {
        question: 'Pick one',
        choices: ['A', "Other (I'll specify)"],
        allowOther: false,
      },
    ]);
    await tick(40);
    stdin.write('2');
    await tick(40);
    stdin.write('custom answer');
    await tick();
    stdin.write(ENTER);
    await tick(40);
    await expect(pending).resolves.toEqual({ answers: ['custom answer'] });
    unmount();
  });

  it('still returns the label for a normal choice', async () => {
    const { stdin, unmount } = renderApp();
    await tick();
    const pending = getInkHandlers()!.requestAskUser([
      { question: 'Pick one', choices: ['A', 'B', 'Other'], allowOther: true },
    ]);
    await tick(40);
    stdin.write('1');
    await tick(40);
    await expect(pending).resolves.toEqual({ answers: ['A'] });
    unmount();
  });

  it('still appends the escape hatch when no "Other"-shaped choice exists', async () => {
    const { stdin, lastFrame, unmount } = renderApp();
    await tick();
    const pending = getInkHandlers()!.requestAskUser([
      { question: 'Pick one', choices: ['A', 'B'], allowOther: true },
    ]);
    await tick(40);
    expect(lastFrame()).toContain('Other (type your own)');
    stdin.write('3');
    await tick(40);
    stdin.write('free text');
    await tick();
    stdin.write(ENTER);
    await tick(40);
    await expect(pending).resolves.toEqual({ answers: ['free text'] });
    unmount();
  });
});

describe('<App> requestAskUser multi-select (#231)', () => {
  beforeEach(() => {
    process.env.BERNARD_HOME = TMP_HOME;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes a multiSelect question to a checkbox menu and returns the chosen labels as an array', async () => {
    const { stdin, lastFrame, unmount } = renderApp();
    await tick();
    const pending = getInkHandlers()!.requestAskUser([
      {
        question: 'Any must-haves?',
        choices: ['Bunkhouse', 'Outdoor kitchen', 'Washer/dryer'],
        allowOther: false,
        multiSelect: true,
      },
    ]);
    await tick(40);
    const frame = lastFrame()!;
    expect(frame).toContain('Any must-haves?');
    expect(frame).toContain('[ ] 1. Bunkhouse');
    expect(stripAnsi(frame)).toContain('space toggle');
    // toggle items 1 and 3, then commit
    stdin.write('1');
    await tick();
    stdin.write('3');
    await tick();
    stdin.write(ENTER);
    await tick(40);
    await expect(pending).resolves.toEqual({ answers: [['Bunkhouse', 'Washer/dryer']] });
    unmount();
  });

  it('routes a toggled "Other" to free text and appends it to the array', async () => {
    const { stdin, lastFrame, unmount } = renderApp();
    await tick();
    const pending = getInkHandlers()!.requestAskUser([
      { question: 'Pick features', choices: ['A', 'B'], allowOther: true, multiSelect: true },
    ]);
    await tick(40);
    expect(lastFrame()).toContain('Other (type your own)');
    // toggle A (1) and the appended Other hatch (3), then commit
    stdin.write('1');
    await tick();
    stdin.write('3');
    await tick();
    stdin.write(ENTER);
    await tick(40);
    // menu replaced by free-text input
    expect(lastFrame()).not.toContain('[ ] 1. A');
    stdin.write('custom feature');
    await tick();
    stdin.write(ENTER);
    await tick(40);
    await expect(pending).resolves.toEqual({ answers: [['A', 'custom feature']] });
    unmount();
  });

  it('keeps index alignment when a batch mixes multi-select and single-select questions', async () => {
    const { stdin, unmount } = renderApp();
    await tick();
    const pending = getInkHandlers()!.requestAskUser([
      { question: 'Multi', choices: ['A', 'B'], allowOther: false, multiSelect: true },
      { question: 'Single', choices: ['X', 'Y'], allowOther: false },
    ]);
    await tick(40);
    // multi: toggle A then commit
    stdin.write('1');
    await tick();
    stdin.write(ENTER);
    await tick(40);
    // single: pick Y
    stdin.write('2');
    await tick(40);
    await expect(pending).resolves.toEqual({ answers: [['A'], 'Y'] });
    unmount();
  });
});

// ── Menu-chain management commands (homogenized onto requestMenu) ──────────

describe('<App> management menu chains', () => {
  const mkSpec = (over: Record<string, unknown> = {}) => ({
    id: 'my-helper',
    name: 'My Helper',
    description: 'helps with things',
    systemPrompt: 'p',
    guidelines: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('/specialists: Back returns to the list; Esc on the list exits', async () => {
    const { stdin, lastFrame, unmount } = renderApp({
      stores: {
        specialists: {
          list: () => [mkSpec()],
          get: () => mkSpec(),
          update: vi.fn(),
          delete: vi.fn(),
        } as never,
      },
    });
    await tick();
    await submit(stdin, '/specialists');
    expect(lastFrame()).toContain('Specialists — select one'); // the list
    stdin.write('1'); // select → action menu
    await tick(40);
    expect(lastFrame()).toContain('Edit');
    stdin.write('4'); // Back → returns to the list (loop), not exit
    await tick(40);
    expect(lastFrame()).toContain('Specialists — select one');
    stdin.write(ESC); // Esc on the list → exit the manager
    await tick(40);
    expect(lastFrame()).not.toContain('Specialists — select one');
    unmount();
  });

  it('/specialists: returning to the list restores the cursor onto the item you entered', async () => {
    const specs = [
      mkSpec({ id: 'alpha', name: 'Alpha' }),
      mkSpec({ id: 'beta', name: 'Beta' }),
      mkSpec({ id: 'gamma', name: 'Gamma' }),
    ];
    const { stdin, lastFrame, unmount } = renderApp({
      stores: {
        specialists: {
          list: () => specs,
          get: (id: string) => specs.find((s) => s.id === id),
          update: vi.fn(),
          delete: vi.fn(),
        } as never,
      },
    });
    await tick();
    await submit(stdin, '/specialists');
    stdin.write('3'); // drill into the 3rd item (Gamma)
    await tick(40);
    expect(lastFrame()).toContain('Edit'); // action menu
    stdin.write('4'); // Back → list
    await tick(40);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('> 3. Gamma'); // cursor restored onto Gamma
    expect(frame).not.toContain('> 1. Alpha');
    unmount();
  });

  it('/specialists: select → Disable calls update({disabled:true})', async () => {
    const update = vi.fn();
    const { stdin, unmount } = renderApp({
      stores: {
        specialists: {
          list: () => [mkSpec()],
          get: () => mkSpec(),
          update,
          delete: vi.fn(),
        } as never,
      },
    });
    await tick();
    await submit(stdin, '/specialists');
    stdin.write('1'); // select the only specialist
    await tick(40);
    stdin.write('2'); // action menu: [Edit, Disable, Delete, Back]
    await tick(40);
    expect(update).toHaveBeenCalledWith('my-helper', { disabled: true });
    unmount();
  });

  it('/specialists: Delete asks to confirm, then deletes', async () => {
    const del = vi.fn(() => true);
    const { stdin, unmount } = renderApp({
      stores: {
        specialists: {
          list: () => [mkSpec()],
          get: () => mkSpec(),
          update: vi.fn(),
          delete: del,
        } as never,
      },
    });
    await tick();
    await submit(stdin, '/specialists');
    stdin.write('1'); // select
    await tick(40);
    stdin.write('3'); // Delete → confirm menu
    await tick(40);
    stdin.write('1'); // confirm: Delete "..."
    await tick(40);
    expect(del).toHaveBeenCalledWith('my-helper');
    unmount();
  });

  it('/routines: Delete confirms and deletes', async () => {
    const r = {
      id: 'my-routine',
      name: 'My Routine',
      description: 'does things',
      content: 'steps',
    };
    const del = vi.fn(() => true);
    const { stdin, unmount } = renderApp({
      stores: { routines: { list: () => [r], get: () => r, delete: del } as never },
    });
    await tick();
    await submit(stdin, '/routines');
    stdin.write('1'); // select
    await tick(40);
    stdin.write('3'); // Delete → confirm
    await tick(40);
    stdin.write('1'); // confirm
    await tick(40);
    expect(del).toHaveBeenCalledWith('my-routine');
    unmount();
  });

  it('/candidates: Reject sets status; Accept promotes', async () => {
    const c = {
      id: 'cand-1',
      draftId: 'code-review',
      name: 'Code Review',
      description: 'reviews code',
      systemPrompt: 'p',
      guidelines: [],
      confidence: 0.9,
      reasoning: 'seen repeated review requests',
      detectedAt: '2026-01-01T00:00:00.000Z',
      source: 'exit',
      acknowledged: false,
      status: 'pending',
    };
    const updateStatus = vi.fn(() => true);
    const { stdin, unmount } = renderApp({
      stores: {
        candidates: { listPending: () => [c], acknowledge: vi.fn(), updateStatus } as never,
      },
    });
    await tick();
    await submit(stdin, '/candidates');
    stdin.write('1'); // select candidate
    await tick(40);
    stdin.write('2'); // action menu: [Accept, Reject, View, Back] → Reject
    await tick(40);
    expect(updateStatus).toHaveBeenCalledWith('cand-1', 'rejected');
    unmount();
  });

  it('/candidates: Accept calls promoteCandidate', async () => {
    vi.mocked(promoteCandidate).mockClear();
    const c = {
      id: 'cand-2',
      draftId: 'triage',
      name: 'Triage',
      description: 'triages',
      systemPrompt: 'p',
      guidelines: [],
      confidence: 0.8,
      reasoning: 'why',
      detectedAt: '2026-01-01T00:00:00.000Z',
      source: 'exit',
      acknowledged: false,
      status: 'pending',
    };
    const { stdin, unmount } = renderApp({
      stores: {
        candidates: {
          listPending: () => [c],
          acknowledge: vi.fn(),
          updateStatus: vi.fn(),
        } as never,
      },
    });
    await tick();
    await submit(stdin, '/candidates');
    stdin.write('1'); // select
    await tick(40);
    stdin.write('1'); // Accept
    await tick(40);
    expect(promoteCandidate).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('/cron: select → Disable flips the job enabled flag', async () => {
    const store = new CronStore();
    const job = store.createJob('Nightly', '0 0 * * *', 'do the thing');
    const { stdin, unmount } = renderApp();
    await tick();
    await submit(stdin, '/cron');
    stdin.write('1'); // select the job
    await tick(40);
    stdin.write('1'); // action menu: [Disable, View logs, Delete, Back]
    await tick(40);
    expect(new CronStore().getJob(job.id)?.enabled).toBe(false);
    store.deleteJob(job.id);
    unmount();
  });
});

describe('buildResumeSeed (--resume transcript replay)', () => {
  it('renders user and assistant text so a resumed session is visible', () => {
    const seed = buildResumeSeed(
      [
        { role: 'user', content: 'recover the photos' },
        { role: 'assistant', content: 'Done — files are in ~/Pictures.' },
      ],
      false,
    );
    expect(seed.map((i) => i.message?.content)).toEqual([
      'recover the photos',
      'Done — files are in ~/Pictures.',
    ]);
  });

  it('drops tool messages and text-less assistant turns', () => {
    // A resumed history is mostly raw tool traffic — 40 of the 92 messages in
    // the reported session. Replaying it verbatim buries the conversation.
    const seed = buildResumeSeed(
      [
        { role: 'user', content: 'list the files' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'shell', args: {} }],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'shell', result: 'a.txt' }],
        },
        { role: 'assistant', content: 'One file: a.txt' },
      ] as CoreMessage[],
      false,
    );
    expect(seed).toHaveLength(2);
    expect(seed.map((i) => i.message?.role)).toEqual(['user', 'assistant']);
  });

  it('hides compression and truncation seams, not just the session boundary', () => {
    // These are injected by compressHistory / emergencyTruncate. Rendering them
    // as `user` turns makes it look like the user typed them.
    const seed = buildResumeSeed(
      [
        { role: 'user', content: '[Context Summary — earlier conversation was compressed.]' },
        {
          role: 'assistant',
          content: "Understood. I have the context from our earlier conversation. Let's continue.",
        },
        { role: 'user', content: '[Earlier conversation was truncated to fit context window.]' },
        { role: 'assistant', content: 'Understood. Continuing with limited context.' },
        { role: 'user', content: 'a real question' },
      ],
      false,
    );
    expect(seed).toHaveLength(1);
    expect(seed[0].message?.content).toBe('a real question');
  });

  it('hides the injected session-boundary scaffolding', () => {
    // These two are prompt mechanics `--resume` appends, not conversation.
    const seed = buildResumeSeed(
      [
        { role: 'user', content: 'earlier question' },
        { role: 'user', content: '[Previous session ended. New session starting. Treat tasks…]' },
        {
          role: 'assistant',
          content:
            "Understood. Starting a new session. I'll only reference prior context if relevant to your current request.",
        },
      ],
      false,
    );
    expect(seed).toHaveLength(1);
    expect(seed[0].message?.content).toBe('earlier question');
  });

  it('truncates a long message for readability', () => {
    const seed = buildResumeSeed([{ role: 'assistant', content: 'x'.repeat(5000) }], false);
    const text = seed[0].message?.content as string;
    expect(text.length).toBeLessThan(5000);
    expect(text.endsWith('…')).toBe(true);
  });

  it('namespaces keys so they cannot collide with live-turn counter keys', () => {
    // Live turns key items off a numeric counter starting at "0"; a collision
    // would make Ink drop or duplicate a rendered block.
    const seed = buildResumeSeed(
      [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
      false,
    );
    expect(seed.map((i) => i.key)).toEqual(['resume-0', 'resume-1']);
  });

  it('returns nothing for an empty history', () => {
    expect(buildResumeSeed([], false)).toEqual([]);
  });
});

/**
 * The abort path that actually exists (#266).
 *
 * `MenuOverlay` and `ModelGridOverlay` each carried a `signal` prop with an
 * abort-listener effect that NO caller ever passed — `grep -rn "signal={"
 * src/ui` returned nothing — so it was exercised only by their own tests.
 * Meanwhile the real case went unhandled: `requestMenu` took no signal at all,
 * and `requestAskUser` polled `signal?.aborted` only BETWEEN questions, so an
 * agent abort while an `ask_user` menu was on screen left the menu up until the
 * user answered it.
 */
describe('<App> overlay abort (#266)', () => {
  beforeEach(() => {
    process.env.BERNARD_HOME = TMP_HOME;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('tears down a live ask_user menu when the turn is aborted', async () => {
    const { lastFrame, unmount } = renderApp();
    await tick();
    const ac = new AbortController();
    const pending = getInkHandlers()!.requestAskUser(
      [{ question: 'Which environment?', choices: ['staging', 'prod'] }],
      ac.signal,
    );
    await tick(40);
    expect(lastFrame()!).toContain('Which environment?');

    ac.abort();
    await tick(40);
    expect(lastFrame()!).not.toContain('Which environment?');
    await expect(pending).resolves.toEqual({ cancelled: true, answered: [] });
    unmount();
  });

  it('tears down a live ask_user free-text prompt when the turn is aborted', async () => {
    const { lastFrame, unmount } = renderApp();
    await tick();
    const ac = new AbortController();
    const pending = getInkHandlers()!.requestAskUser(
      [{ question: 'Name the release?' }],
      ac.signal,
    );
    await tick(40);
    expect(lastFrame()!).toContain('Name the release?');

    ac.abort();
    await tick(40);
    expect(lastFrame()!).not.toContain('Name the release?');
    await expect(pending).resolves.toEqual({ cancelled: true, answered: [] });
    unmount();
  });

  it('never opens the overlay when the signal is already aborted', async () => {
    const { lastFrame, unmount } = renderApp();
    await tick();
    const ac = new AbortController();
    ac.abort();
    const result = await getInkHandlers()!.requestMenu(
      [{ label: 'only-choice' }],
      { title: 'should not appear' },
      ac.signal,
    );
    await tick(40);
    expect(result).toEqual({ cancelled: true });
    expect(lastFrame()!).not.toContain('should not appear');
    unmount();
  });

  it('forwards the signal through the ink-handlers bridge shim', async () => {
    // The shim used to take only `(entries, options)`, so a signal handed to
    // `getInkHandlers().requestMenu` was silently dropped one frame short of
    // the overlay. This asserts it arrives.
    const { lastFrame, unmount } = renderApp();
    await tick();
    const ac = new AbortController();
    const pending = getInkHandlers()!.requestMenu(
      [{ label: 'only-choice' }],
      { title: 'bridge menu' },
      ac.signal,
    );
    await tick(40);
    expect(lastFrame()!).toContain('bridge menu');
    ac.abort();
    await tick(40);
    expect(lastFrame()!).not.toContain('bridge menu');
    await expect(pending).resolves.toEqual({ cancelled: true });
    unmount();
  });
});
