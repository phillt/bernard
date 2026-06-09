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
import { getInkHandlers } from '../ink-handlers.js';
import type { CoreMessage } from 'ai';
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
  /** Live history array `getHistory()` returns; mutate it from `processInput`. */
  history?: CoreMessage[];
  /** Holder whose `.current` `getHistory()` returns; swap it to simulate a mid-turn replace. */
  holder?: { current: CoreMessage[] };
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
      agent: makeAgent(agentSpy, opts.history, opts.holder),
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
    expect(frame).toContain('Space toggle');
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
