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
import { ENTER, tick } from './_keys.js';

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

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(async () => ({ text: '' })),
  };
});

// Isolated XDG home so CronStore / MemoryStore can't see user data.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bernard-app-test-'));
process.env.BERNARD_HOME = TMP_HOME;

// ── Imports under test (after mocks + env) ──────────────────────────────
import { App, type AppStores } from '../App.js';
import type { BernardConfig } from '../../config.js';
import type { Agent } from '../../agent.js';
import type { HistoryStore } from '../../history.js';
import type { ProvenanceHistoryStore } from '../../provenance-history.js';
import type { MemoryStore } from '../../memory.js';
import type { RoutineStore } from '../../routines.js';
import type { SpecialistStore } from '../../specialists.js';
import type { CandidateStore } from '../../specialist-candidates.js';

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

function makeAgent(spy: Partial<AgentSpy> = {}): Agent {
  const stubs: AgentSpy = {
    processInput: vi.fn(async () => {}),
    clearHistory: vi.fn(),
    compactHistory: vi.fn(async () => ({ compacted: false })),
    ...spy,
  };
  return {
    getHistory: () => [],
    clearHistory: stubs.clearHistory,
    compactHistory: stubs.compactHistory,
    processInput: stubs.processInput,
    getLastPolicyDecision: () => null,
    getLastRAGResults: () => [],
    getTurnProvenance: () => [],
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
    spinnerStats: null,
  } as unknown as Agent;
}

function makeStores(): AppStores {
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
    } as unknown as RoutineStore,
    specialists: {
      list: () => [],
      get: () => undefined,
    } as unknown as SpecialistStore,
    candidates: {
      listPending: () => [],
      list: () => [],
    } as unknown as CandidateStore,
  };
}

interface HarnessOptions {
  agent?: Partial<AgentSpy>;
  alertBanner?: string;
  config?: Partial<BernardConfig>;
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
  const sessionToolAllowlist = new Set<string>();
  const stores = makeStores();
  const config = makeConfig(opts.config);
  const utils = render(
    createElement(App, {
      agent: makeAgent(agentSpy),
      config,
      historyStore,
      provenanceHistoryStore,
      stores,
      sessionToolAllowlist,
      onExit,
      alertBanner: opts.alertBanner,
    }),
  );
  return {
    ...utils,
    agentSpy,
    onExit,
    historyStore,
    provenanceHistoryStore,
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
    expect(frame).toContain('/exit');
    expect(frame).toContain('/help');
    expect(frame).toContain('/memory');
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
