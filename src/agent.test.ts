import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildSystemPrompt,
  Agent,
  shouldEnforcePlan,
  computeEffectiveMaxSteps,
  REACT_MAX_STEPS_CEILING,
} from './agent.js';
import type { BernardConfig } from './config.js';
import { MemoryStore } from './memory.js';
import { printWarning, printInfo } from './output.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}));

const fs = await import('node:fs');

vi.mock('./providers/index.js', () => ({
  getModel: vi.fn(() => ({ modelId: 'mock' })),
  getModelProfile: vi.fn(() => ({
    family: 'test',
    wrapUserMessage: (m: string) => m,
    systemSuffix: '',
  })),
}));

vi.mock('./output.js', () => ({
  printAssistantText: vi.fn(),
  printToolCall: vi.fn(),
  printToolResult: vi.fn(),
  printInfo: vi.fn(),
  printWarning: vi.fn(),
  printCriticRetry: vi.fn(),
  startSpinner: vi.fn(),
  stopSpinner: vi.fn(),
  buildSpinnerMessage: vi.fn(() => ''),
  clearPinnedRegion: vi.fn(),
}));

vi.mock('./context.js', () => ({
  shouldCompress: vi.fn(() => false),
  compressHistory: vi.fn((history: any) => Promise.resolve(history)),
  truncateToolResults: vi.fn((messages: any) => messages),
  estimateHistoryTokens: vi.fn(() => 1000),
  emergencyTruncate: vi.fn((history: any) => history),
  isTokenOverflowError: vi.fn(() => false),
  getContextWindow: vi.fn(() => 200_000),
  extractText: vi.fn((msg: any) => {
    if (typeof msg.content === 'string') return msg.content;
    return null;
  }),
}));

const mockExtractRecentUserTexts = vi.fn((): string[] => []);
const mockExtractRecentToolContext = vi.fn((): string => '');
const mockBuildRAGQuery = vi.fn((input: string) => input);
const mockApplyStickiness = vi.fn((results: any) => results);
vi.mock('./rag-query.js', () => ({
  extractRecentUserTexts: (...args: any[]) => mockExtractRecentUserTexts(...args),
  extractRecentToolContext: (...args: any[]) => mockExtractRecentToolContext(...args),
  buildRAGQuery: (...args: any[]) => mockBuildRAGQuery(...args),
  applyStickiness: (...args: any[]) => mockApplyStickiness(...args),
}));

const mockSubAgentTool = { description: 'mock sub-agent', execute: vi.fn() };
vi.mock('./tools/subagent.js', () => ({
  createSubAgentTool: vi.fn(() => mockSubAgentTool),
}));

const mockGenerateText = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    generateText: (...args: any[]) => mockGenerateText(...args),
  };
});

function makeConfig(overrides?: Partial<BernardConfig>): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    maxSteps: 25,
    ragEnabled: true,
    theme: 'bernard',
    criticMode: false,
    reactMode: false,
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    anthropicApiKey: 'sk-test',
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  let store: MemoryStore;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fs mocks to defaults
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    store = new MemoryStore();
  });

  it('includes the base system prompt', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).toContain('You are Bernard');
  });

  it('includes current date and time', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).toContain('Current date and time:');
    // Should contain a year and time pattern
    expect(prompt).toMatch(/\d{4}/);
    expect(prompt).toMatch(/\d{1,2}:\d{2}/);
  });

  it('includes provider and model', () => {
    const prompt = buildSystemPrompt(
      makeConfig({ provider: 'openai', model: 'gpt-4o-mini' }),
      store,
    );
    expect(prompt).toContain('openai');
    expect(prompt).toContain('gpt-4o-mini');
  });

  it('includes memories when present', () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['prefs.md'] as any);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('dark mode enabled');
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).toContain('Persistent Memory');
    expect(prompt).toContain('prefs');
    expect(prompt).toContain('dark mode enabled');
  });

  it('excludes memory section when empty', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).not.toContain('## Persistent Memory');
  });

  it('includes scratch when present', () => {
    store.writeScratch('todo', 'step 1 done');
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).toContain('Scratch Notes');
    expect(prompt).toContain('todo');
    expect(prompt).toContain('step 1 done');
  });

  it('excludes scratch section when empty', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).not.toContain('## Scratch Notes');
  });

  it('includes MCP server names when provided', () => {
    const prompt = buildSystemPrompt(makeConfig(), store, ['filesystem', 'github']);
    expect(prompt).toContain('filesystem');
    expect(prompt).toContain('github');
  });

  it('shows "No MCP servers" when none connected', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).toContain('No MCP servers are currently connected');
  });

  it('includes execution model constraints', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).toContain('Execution Model');
    expect(prompt).toContain('cease execution until the next message');
  });

  it('frames recalled context as hints not rules in system prompt', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).toContain('hints, not rules');
    expect(prompt).toContain('auto-retrieved hints');
  });

  it('separates Persistent Memory and Recalled Context in instruction hierarchy', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).toContain('3. Persistent Memory');
    expect(prompt).toContain('4. Recalled Context');
    expect(prompt).toContain('5. External content');
  });

  it('includes routine summaries when provided', () => {
    const summaries = [
      { id: 'deploy', name: 'Deploy', description: 'Deploy to prod' },
      { id: 'release', name: 'Release', description: 'Cut a release' },
    ];
    const prompt = buildSystemPrompt(makeConfig(), store, undefined, undefined, summaries);
    expect(prompt).toContain('## Routines');
    expect(prompt).toContain('/deploy');
    expect(prompt).toContain('Deploy to prod');
    expect(prompt).toContain('/release');
    expect(prompt).toContain('Cut a release');
  });

  it('includes "no routines" message when empty', () => {
    const prompt = buildSystemPrompt(makeConfig(), store, undefined, undefined, []);
    expect(prompt).toContain('## Routines');
    expect(prompt).toContain('No routines or tasks saved yet');
  });

  it('includes "no routines" message when undefined', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).toContain('## Routines');
    expect(prompt).toContain('No routines or tasks saved yet');
  });

  it('includes routine tool in base system prompt', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).toContain('routine');
    expect(prompt).toContain('/{routine-id}');
  });

  it('includes tool execution integrity rules', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).toContain('Tool Execution Integrity');
    expect(prompt).toContain('NEVER simulate');
  });

  it('includes error handling guidance prohibiting identical retries', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).toContain('Never retry the exact same command that just failed');
  });

  it('includes eventual consistency guidance', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).toContain('eventual consistency');
    expect(prompt).toContain('wait tool');
  });

  it('includes model tags for specialists with provider/model overrides', () => {
    const specialists = [
      {
        id: 'code-reviewer',
        name: 'Code Reviewer',
        description: 'Reviews code',
        provider: 'xai',
        model: 'grok-code-fast-1',
      },
    ];
    const prompt = buildSystemPrompt(
      makeConfig(),
      store,
      undefined,
      undefined,
      undefined,
      specialists,
    );
    expect(prompt).toContain('[xai/grok-code-fast-1]');
  });

  it('shows default tag for partial model overrides', () => {
    const specialists = [
      { id: 'code-reviewer', name: 'Code Reviewer', description: 'Reviews code', provider: 'xai' },
    ];
    const prompt = buildSystemPrompt(
      makeConfig(),
      store,
      undefined,
      undefined,
      undefined,
      specialists,
    );
    expect(prompt).toContain('[xai/default]');
  });

  it('omits model tag for specialists without overrides', () => {
    const specialists = [
      { id: 'code-reviewer', name: 'Code Reviewer', description: 'Reviews code' },
    ];
    const prompt = buildSystemPrompt(
      makeConfig(),
      store,
      undefined,
      undefined,
      undefined,
      specialists,
    );
    expect(prompt).toContain('code-reviewer');
    // The specialist listing line itself should not include a model/kind tag.
    const listingLine = prompt.split('\n').find((l) => l.startsWith('- code-reviewer'));
    expect(listingLine).toBeDefined();
    expect(listingLine).not.toContain('[');
  });

  it('includes auto-dispatch instructions when specialists are provided', () => {
    const specialists = [
      { id: 'code-reviewer', name: 'Code Reviewer', description: 'Reviews code' },
    ];
    const prompt = buildSystemPrompt(
      makeConfig(),
      store,
      undefined,
      undefined,
      undefined,
      specialists,
    );
    expect(prompt).toContain('delegate to it via specialist_run without asking for permission');
  });

  it('includes specialist match advisory with AUTO-DISPATCH tag for high scores', () => {
    const specialists = [
      { id: 'code-reviewer', name: 'Code Reviewer', description: 'Reviews code' },
    ];
    const matches = [{ id: 'code-reviewer', name: 'Code Reviewer', score: 0.95 }];
    const prompt = buildSystemPrompt(
      makeConfig(),
      store,
      undefined,
      undefined,
      undefined,
      specialists,
      matches,
    );
    expect(prompt).toContain('### Specialist Match Advisory');
    expect(prompt).toContain('AUTO-DISPATCH: score >= 0.8');
    expect(prompt).toContain('code-reviewer (score: 0.95)');
  });

  it('includes CONFIRM WITH USER tag for medium scores', () => {
    const specialists = [
      { id: 'deploy-manager', name: 'Deploy Manager', description: 'Manages deploys' },
    ];
    const matches = [{ id: 'deploy-manager', name: 'Deploy Manager', score: 0.55 }];
    const prompt = buildSystemPrompt(
      makeConfig(),
      store,
      undefined,
      undefined,
      undefined,
      specialists,
      matches,
    );
    expect(prompt).toContain('CONFIRM WITH USER: score 0.4');
    expect(prompt).toContain('deploy-manager (score: 0.55)');
  });

  it('omits specialist match advisory when matches array is empty', () => {
    const specialists = [
      { id: 'code-reviewer', name: 'Code Reviewer', description: 'Reviews code' },
    ];
    const prompt = buildSystemPrompt(
      makeConfig(),
      store,
      undefined,
      undefined,
      undefined,
      specialists,
      [],
    );
    expect(prompt).not.toContain('Specialist Match Advisory');
  });

  it('omits specialist match advisory when matches is undefined', () => {
    const specialists = [
      { id: 'code-reviewer', name: 'Code Reviewer', description: 'Reviews code' },
    ];
    const prompt = buildSystemPrompt(
      makeConfig(),
      store,
      undefined,
      undefined,
      undefined,
      specialists,
    );
    expect(prompt).not.toContain('Specialist Match Advisory');
  });

  it('includes coordinator prompt when reactMode is true', () => {
    const prompt = buildSystemPrompt(makeConfig({ reactMode: true }), store);
    expect(prompt).toContain('Coordinator Mode (Active)');
    expect(prompt).toContain('Delegate scoped work');
    expect(prompt).toContain('Reason before acting');
  });

  it('coordinator prompt mandates plan, think, and evaluate tools', () => {
    const prompt = buildSystemPrompt(makeConfig({ reactMode: true }), store);
    expect(prompt).toContain('`plan`');
    expect(prompt).toContain('`think`');
    expect(prompt).toContain('`evaluate`');
    expect(prompt).toContain('terminal state');
    expect(prompt).toContain('cancelled');
    expect(prompt).toContain('error');
  });

  it('coordinator prompt describes the think -> act -> evaluate -> decide loop', () => {
    const prompt = buildSystemPrompt(makeConfig({ reactMode: true }), store);
    expect(prompt).toContain('think \u2192 act \u2192 evaluate \u2192 decide');
    expect(prompt).toContain('Stop and evaluate');
    expect(prompt).toContain('course-correct');
  });

  it('coordinator prompt mandates reflective scratch notes and final synthesis', () => {
    const prompt = buildSystemPrompt(makeConfig({ reactMode: true }), store);
    expect(prompt).toContain('reflective notes in `scratch`');
    expect(prompt).toContain('step-{id}');
    expect(prompt).toContain('Synthesize the final response from scratch');
    expect(prompt).toContain('not from the conversation tail');
  });

  it('excludes coordinator prompt when reactMode is false', () => {
    const prompt = buildSystemPrompt(makeConfig({ reactMode: false }), store);
    expect(prompt).not.toContain('Coordinator Mode');
  });
});

describe('shouldEnforcePlan', () => {
  const base = { reactMode: true, aborted: false, stepLimitHit: false, hasSteps: true };

  it('returns true when all gates pass', () => {
    expect(shouldEnforcePlan(base)).toBe(true);
  });

  it('returns false when reactMode is off', () => {
    expect(shouldEnforcePlan({ ...base, reactMode: false })).toBe(false);
  });

  it('returns false when aborted', () => {
    expect(shouldEnforcePlan({ ...base, aborted: true })).toBe(false);
  });

  it('returns false when step-limit was hit', () => {
    expect(shouldEnforcePlan({ ...base, stepLimitHit: true })).toBe(false);
  });

  it('returns false when the plan has no steps', () => {
    expect(shouldEnforcePlan({ ...base, hasSteps: false })).toBe(false);
  });
});

describe('computeEffectiveMaxSteps', () => {
  it('returns maxSteps unchanged when reactMode is off', () => {
    expect(computeEffectiveMaxSteps(25, false)).toBe(25);
    expect(computeEffectiveMaxSteps(500, false)).toBe(500);
  });

  it('triples maxSteps when reactMode is on and below the ceiling', () => {
    expect(computeEffectiveMaxSteps(25, true)).toBe(75);
    expect(computeEffectiveMaxSteps(10, true)).toBe(30);
  });

  it('clamps to REACT_MAX_STEPS_CEILING when triple would exceed it', () => {
    expect(computeEffectiveMaxSteps(100, true)).toBe(REACT_MAX_STEPS_CEILING);
    expect(computeEffectiveMaxSteps(1000, true)).toBe(REACT_MAX_STEPS_CEILING);
  });

  it('triple exactly at ceiling is unchanged', () => {
    expect(computeEffectiveMaxSteps(REACT_MAX_STEPS_CEILING / 3, true)).toBe(
      REACT_MAX_STEPS_CEILING,
    );
  });
});

describe('Agent', () => {
  let store: MemoryStore;
  const toolOptions = {
    shellTimeout: 30000,
    confirmDangerous: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    store = new MemoryStore();
  });

  it('processInput calls generateText', async () => {
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    const agent = new Agent(makeConfig(), toolOptions, store);
    await agent.processInput('Hello');
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it('processInput passes timestamped user message in history', async () => {
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    const agent = new Agent(makeConfig(), toolOptions, store);
    await agent.processInput('Hello');
    const call = mockGenerateText.mock.calls[0][0];
    const userMsg = call.messages.find((m: any) => m.role === 'user');
    expect(userMsg.content).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] Hello$/,
    );
  });

  it('appends response messages to history', async () => {
    const responseMsg = { role: 'assistant', content: 'First response' };
    mockGenerateText.mockResolvedValue({
      response: { messages: [responseMsg] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    const agent = new Agent(makeConfig(), toolOptions, store);
    await agent.processInput('Hello');

    // Second call should have both the user message, response, and new user message
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Second response' }] },
      usage: { promptTokens: 200, completionTokens: 60, totalTokens: 260 },
    });
    await agent.processInput('Follow up');
    const call = mockGenerateText.mock.calls[1][0];
    expect(call.messages.length).toBeGreaterThan(2);
  });

  it('clearHistory resets messages and clears scratch', () => {
    store.writeScratch('todo', 'test');
    const agent = new Agent(makeConfig(), toolOptions, store);
    agent.clearHistory();
    expect(store.listScratch()).toEqual([]);
  });

  it('wraps errors with "Agent error:" prefix', async () => {
    mockGenerateText.mockRejectedValue(new Error('API rate limit'));
    const agent = new Agent(makeConfig(), toolOptions, store);
    await expect(agent.processInput('Hello')).rejects.toThrow('Agent error: API rate limit');
  });

  it('tools passed to generateText include agent property', async () => {
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    const agent = new Agent(makeConfig(), toolOptions, store);
    await agent.processInput('Hello');
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.tools).toHaveProperty('agent');
    // augmentTools wraps execute, so check description rather than reference identity
    expect(call.tools.agent.description).toBe(mockSubAgentTool.description);
  });

  it('system prompt contains sub-agent guidance text', async () => {
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    const agent = new Agent(makeConfig(), toolOptions, store);
    await agent.processInput('Hello');
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('agent tool');
    expect(call.system).toContain('parallel');
  });

  it('system prompt contains prescriptive sub-agent prompt guidance', async () => {
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    const agent = new Agent(makeConfig(), toolOptions, store);
    await agent.processInput('Hello');
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('Success criteria');
    expect(call.system).toContain('Edge cases');
  });

  it('system prompt contains web_read guidance text', async () => {
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    const agent = new Agent(makeConfig(), toolOptions, store);
    await agent.processInput('Hello');
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.system).toContain('web_read');
    expect(call.system).toContain('web pages');
  });

  it('system prompt contains Recalled Context when ragResults provided', () => {
    const ragResults = [
      { fact: 'User prefers dark mode', similarity: 0.85, domain: 'user-preferences' },
      { fact: 'Project uses TypeScript', similarity: 0.72, domain: 'general' },
    ];
    const prompt = buildSystemPrompt(makeConfig(), store, undefined, ragResults);
    expect(prompt).toContain('Recalled Context');
    expect(prompt).toContain('User prefers dark mode');
    expect(prompt).toContain('Project uses TypeScript');
  });

  it('system prompt groups recalled context by domain with ### headings', () => {
    const ragResults = [
      { fact: 'npm run build compiles project', similarity: 0.9, domain: 'tool-usage' },
      { fact: 'User prefers dark mode', similarity: 0.85, domain: 'user-preferences' },
      { fact: 'Project uses TypeScript', similarity: 0.72, domain: 'general' },
    ];
    const prompt = buildSystemPrompt(makeConfig(), store, undefined, ragResults);
    expect(prompt).toContain('### Tool Usage Patterns');
    expect(prompt).toContain('### User Preferences');
    expect(prompt).toContain('### General Knowledge');
  });

  it('system prompt handles mixed-domain results correctly', () => {
    const ragResults = [
      { fact: 'git commit -m works', similarity: 0.9, domain: 'tool-usage' },
      { fact: 'npm test runs vitest', similarity: 0.85, domain: 'tool-usage' },
      { fact: 'User prefers concise responses', similarity: 0.8, domain: 'user-preferences' },
    ];
    const prompt = buildSystemPrompt(makeConfig(), store, undefined, ragResults);
    expect(prompt).toContain('### Tool Usage Patterns');
    expect(prompt).toContain('### User Preferences');
    // General should not appear if no general facts
    expect(prompt).not.toContain('### General Knowledge');
    // Both tool facts under same heading
    expect(prompt).toContain('git commit -m works');
    expect(prompt).toContain('npm test runs vitest');
  });

  it('system prompt omits Recalled Context section when ragResults is empty', () => {
    const prompt = buildSystemPrompt(makeConfig(), store, undefined, []);
    expect(prompt).not.toContain('## Recalled Context');
  });

  it('system prompt omits Recalled Context section when ragResults is undefined', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    expect(prompt).not.toContain('## Recalled Context');
  });

  it('RAG search failure does not break processInput', async () => {
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const mockRagStore = {
      search: vi.fn().mockRejectedValue(new Error('RAG failure')),
      addFacts: vi.fn(),
    };

    const agent = new Agent(
      makeConfig(),
      toolOptions,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRagStore as any,
    );
    // Should not throw
    await agent.processInput('Hello');
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it('passes ragStore to compressHistory when compression triggers', async () => {
    const { shouldCompress, compressHistory } = await import('./context.js');
    vi.mocked(shouldCompress).mockReturnValueOnce(true);

    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const mockRagStore = {
      search: vi.fn().mockResolvedValue([]),
      addFacts: vi.fn(),
    };

    const agent = new Agent(
      makeConfig(),
      toolOptions,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRagStore as any,
    );
    await agent.processInput('Hello');

    expect(compressHistory).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      mockRagStore,
    );
  });

  it('truncates tool results before adding to history', async () => {
    const { truncateToolResults } = await import('./context.js');
    const responseMessages = [
      { role: 'assistant', content: 'Here is the result' },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'tc1', result: 'x'.repeat(50_000) }],
      },
    ];

    mockGenerateText.mockResolvedValue({
      response: { messages: responseMessages },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const agent = new Agent(makeConfig(), toolOptions, store);
    await agent.processInput('Hello');

    expect(truncateToolResults).toHaveBeenCalledWith(responseMessages);
  });

  it('pre-flight guard triggers emergency truncation when estimated tokens exceed limit', async () => {
    const { estimateHistoryTokens, emergencyTruncate, getContextWindow } =
      await import('./context.js');
    // Simulate high token estimate: 190k estimated vs 200k * 0.9 = 180k limit
    vi.mocked(estimateHistoryTokens).mockReturnValue(185_000);
    vi.mocked(getContextWindow).mockReturnValue(200_000);

    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const agent = new Agent(makeConfig(), toolOptions, store);
    await agent.processInput('Hello');

    expect(emergencyTruncate).toHaveBeenCalled();
  });

  it('catch-and-retry triggers on token overflow error', async () => {
    const { isTokenOverflowError, emergencyTruncate } = await import('./context.js');
    vi.mocked(isTokenOverflowError).mockReturnValue(true);

    let callCount = 0;
    mockGenerateText.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error(
          "This model's maximum prompt length is 131072 but the request contains 134090 tokens",
        );
      }
      return {
        response: { messages: [{ role: 'assistant', content: 'Recovered!' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    });

    const agent = new Agent(makeConfig(), toolOptions, store);
    await agent.processInput('Hello');

    // generateText called twice (first fails, second succeeds)
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(emergencyTruncate).toHaveBeenCalled();
  });

  it('passes ragStore to createSubAgentTool', async () => {
    const { createSubAgentTool } = await import('./tools/subagent.js');

    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const mockRagStore = {
      search: vi.fn().mockResolvedValue([]),
      addFacts: vi.fn(),
    };

    const agent = new Agent(
      makeConfig(),
      toolOptions,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRagStore as any,
    );
    await agent.processInput('Hello');

    expect(createSubAgentTool).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
      undefined,
      mockRagStore,
    );
  });

  it('retry uses 0.6 ratio when pre-flight already truncated', async () => {
    const { isTokenOverflowError, emergencyTruncate, estimateHistoryTokens, getContextWindow } =
      await import('./context.js');

    // Make pre-flight trigger by reporting high token estimate
    vi.mocked(estimateHistoryTokens).mockReturnValue(185_000);
    vi.mocked(getContextWindow).mockReturnValue(200_000);
    vi.mocked(isTokenOverflowError).mockReturnValue(true);

    let callCount = 0;
    mockGenerateText.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("This model's maximum prompt length exceeded");
      }
      return {
        response: { messages: [{ role: 'assistant', content: 'Recovered!' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    });

    const agent = new Agent(makeConfig(), toolOptions, store);
    await agent.processInput('Hello');

    // emergencyTruncate called twice: pre-flight + retry
    expect(emergencyTruncate).toHaveBeenCalledTimes(2);

    // Second call (retry) should use contextWindow * 0.6 = 120_000
    const retryCall = vi.mocked(emergencyTruncate).mock.calls[1];
    expect(retryCall[1]).toBe(200_000 * 0.6);
  });

  it('non-token errors still throw normally', async () => {
    const { isTokenOverflowError } = await import('./context.js');
    vi.mocked(isTokenOverflowError).mockReturnValue(false);

    mockGenerateText.mockRejectedValue(new Error('API rate limit'));
    const agent = new Agent(makeConfig(), toolOptions, store);
    await expect(agent.processInput('Hello')).rejects.toThrow('Agent error: API rate limit');
  });

  it('passes enriched query to ragStore.search when history exists', async () => {
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const mockRagStore = {
      search: vi.fn().mockResolvedValue([]),
      addFacts: vi.fn(),
    };

    // Simulate history providing prior user texts
    mockExtractRecentUserTexts.mockReturnValueOnce(['what build tools do we use?']);
    mockBuildRAGQuery.mockReturnValueOnce('what build tools do we use?. how about compile?');

    const agent = new Agent(
      makeConfig(),
      toolOptions,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRagStore as any,
    );
    await agent.processInput('how about compile?');

    expect(mockRagStore.search).toHaveBeenCalledWith(
      'what build tools do we use?. how about compile?',
    );
  });

  it('first message passes raw userInput to ragStore.search', async () => {
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const mockRagStore = {
      search: vi.fn().mockResolvedValue([]),
      addFacts: vi.fn(),
    };

    // No history — extractRecentUserTexts returns []
    mockExtractRecentUserTexts.mockReturnValueOnce([]);
    mockBuildRAGQuery.mockReturnValueOnce('Hello');

    const agent = new Agent(
      makeConfig(),
      toolOptions,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRagStore as any,
    );
    await agent.processInput('Hello');

    expect(mockRagStore.search).toHaveBeenCalledWith('Hello');
  });

  it('applies stickiness to RAG results', async () => {
    const ragResults = [{ fact: 'fact A', similarity: 0.8, domain: 'general' }];
    const boostedResults = [{ fact: 'fact A', similarity: 0.85, domain: 'general' }];

    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const mockRagStore = {
      search: vi.fn().mockResolvedValue(ragResults),
      addFacts: vi.fn(),
    };

    mockApplyStickiness.mockReturnValueOnce(boostedResults);

    const agent = new Agent(
      makeConfig(),
      toolOptions,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRagStore as any,
    );
    await agent.processInput('Hello');

    expect(mockApplyStickiness).toHaveBeenCalledWith(ragResults, expect.any(Set));
  });

  it('getLastRAGResults returns empty array before any input', () => {
    const agent = new Agent(makeConfig(), toolOptions, store);
    expect(agent.getLastRAGResults()).toEqual([]);
  });

  it('getLastRAGResults returns RAG results after a turn with RAG hits', async () => {
    const ragResults = [
      { fact: 'User prefers dark mode', similarity: 0.85, domain: 'user-preferences' },
      { fact: 'Project uses TypeScript', similarity: 0.72, domain: 'general' },
    ];

    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const mockRagStore = {
      search: vi.fn().mockResolvedValue(ragResults),
      addFacts: vi.fn(),
    };

    mockApplyStickiness.mockReturnValueOnce(ragResults);

    const agent = new Agent(
      makeConfig(),
      toolOptions,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRagStore as any,
    );
    await agent.processInput('Hello');

    expect(agent.getLastRAGResults()).toEqual(ragResults);
  });

  it('getLastRAGResults resets between turns', async () => {
    const firstResults = [{ fact: 'fact A', similarity: 0.9, domain: 'general' }];

    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const mockRagStore = {
      search: vi.fn().mockResolvedValue(firstResults),
      addFacts: vi.fn(),
    };

    mockApplyStickiness.mockReturnValueOnce(firstResults);

    const agent = new Agent(
      makeConfig(),
      toolOptions,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRagStore as any,
    );
    await agent.processInput('Hello');
    expect(agent.getLastRAGResults()).toEqual(firstResults);

    // Second turn with no results
    mockRagStore.search.mockResolvedValue([]);
    mockApplyStickiness.mockReturnValueOnce([]);

    await agent.processInput('Hi again');
    expect(agent.getLastRAGResults()).toEqual([]);
  });

  it('getLastRAGResults is empty when RAG search fails', async () => {
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const mockRagStore = {
      search: vi.fn().mockRejectedValue(new Error('RAG failure')),
      addFacts: vi.fn(),
    };

    const agent = new Agent(
      makeConfig(),
      toolOptions,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRagStore as any,
    );
    await agent.processInput('Hello');
    expect(agent.getLastRAGResults()).toEqual([]);
  });

  it('clearHistory resets lastRAGResults', async () => {
    const ragResults = [{ fact: 'fact A', similarity: 0.8, domain: 'general' }];

    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const mockRagStore = {
      search: vi.fn().mockResolvedValue(ragResults),
      addFacts: vi.fn(),
    };

    mockApplyStickiness.mockReturnValueOnce(ragResults);

    const agent = new Agent(
      makeConfig(),
      toolOptions,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRagStore as any,
    );
    await agent.processInput('Hello');
    expect(agent.getLastRAGResults()).toEqual(ragResults);

    agent.clearHistory();
    expect(agent.getLastRAGResults()).toEqual([]);
  });

  it('passes tool context to buildRAGQuery when present', async () => {
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const mockRagStore = {
      search: vi.fn().mockResolvedValue([]),
      addFacts: vi.fn(),
    };

    mockExtractRecentUserTexts.mockReturnValueOnce([]);
    mockExtractRecentToolContext.mockReturnValueOnce('shell(command=ls)');
    mockBuildRAGQuery.mockReturnValueOnce('Hello');

    const agent = new Agent(
      makeConfig(),
      toolOptions,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRagStore as any,
    );
    await agent.processInput('Hello');

    expect(mockBuildRAGQuery).toHaveBeenCalledWith('Hello', [], {
      toolContext: 'shell(command=ls)',
    });
  });

  it('passes undefined toolContext when extractRecentToolContext returns empty string', async () => {
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const mockRagStore = {
      search: vi.fn().mockResolvedValue([]),
      addFacts: vi.fn(),
    };

    mockExtractRecentUserTexts.mockReturnValueOnce([]);
    mockExtractRecentToolContext.mockReturnValueOnce('');
    mockBuildRAGQuery.mockReturnValueOnce('Hello');

    const agent = new Agent(
      makeConfig(),
      toolOptions,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRagStore as any,
    );
    await agent.processInput('Hello');

    expect(mockBuildRAGQuery).toHaveBeenCalledWith('Hello', [], {
      toolContext: undefined,
    });
  });

  describe('compactHistory', () => {
    it('returns compacted: false when history is too short to compress', async () => {
      const agent = new Agent(makeConfig(), toolOptions, store);
      const result = await agent.compactHistory();
      expect(result.compacted).toBe(false);
    });

    it('returns compacted: true with reduced tokens when compression succeeds', async () => {
      const { compressHistory, estimateHistoryTokens } = await import('./context.js');
      const compressedHistory = [{ role: 'user' as const, content: 'summary' }];
      vi.mocked(compressHistory).mockResolvedValueOnce(compressedHistory);

      let callCount = 0;
      vi.mocked(estimateHistoryTokens).mockImplementation(() => {
        callCount++;
        // First call: tokensBefore (5000); subsequent calls (lastPromptTokens, tokensAfter): 1000
        return callCount === 1 ? 5000 : 1000;
      });

      mockGenerateText.mockResolvedValue({
        response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });

      const agent = new Agent(makeConfig(), toolOptions, store);
      await agent.processInput('Hello');

      callCount = 0;
      const result = await agent.compactHistory();
      expect(result.compacted).toBe(true);
      expect(result.tokensBefore).toBe(5000);
      expect(result.tokensAfter).toBe(1000);
    });

    it('updates internal history after compaction', async () => {
      const { compressHistory, estimateHistoryTokens } = await import('./context.js');
      const compressedHistory = [{ role: 'user' as const, content: 'compressed' }];
      vi.mocked(compressHistory).mockResolvedValueOnce(compressedHistory);
      vi.mocked(estimateHistoryTokens).mockReturnValue(500);

      mockGenerateText.mockResolvedValue({
        response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });

      const agent = new Agent(makeConfig(), toolOptions, store);
      await agent.processInput('Hello');
      await agent.compactHistory();

      expect(agent.getHistory()).toBe(compressedHistory);
    });

    it('returns compacted: false when compressHistory returns same reference', async () => {
      const { compressHistory, estimateHistoryTokens } = await import('./context.js');
      // Default mock returns the same reference — simulates "nothing to compress"
      vi.mocked(compressHistory).mockImplementation((history: any) => Promise.resolve(history));
      vi.mocked(estimateHistoryTokens).mockReturnValue(1000);

      const agent = new Agent(makeConfig(), toolOptions, store);
      const result = await agent.compactHistory();
      expect(result.compacted).toBe(false);
      expect(result.tokensBefore).toBe(1000);
      expect(result.tokensAfter).toBe(1000);
    });

    it('propagates errors from compressHistory', async () => {
      const { compressHistory } = await import('./context.js');
      vi.mocked(compressHistory).mockRejectedValueOnce(new Error('LLM down'));

      const agent = new Agent(makeConfig(), toolOptions, store);
      await expect(agent.compactHistory()).rejects.toThrow('LLM down');
    });
  });

  it('clearHistory resets previousRAGFacts', async () => {
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const ragResults = [{ fact: 'fact A', similarity: 0.8, domain: 'general' }];

    const mockRagStore = {
      search: vi.fn().mockResolvedValue(ragResults),
      addFacts: vi.fn(),
    };

    mockApplyStickiness.mockImplementation((results: any) => results);

    const agent = new Agent(
      makeConfig(),
      toolOptions,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRagStore as any,
    );

    // First call — builds up previousRAGFacts
    await agent.processInput('Hello');
    // applyStickiness should have been called with empty Set (first turn)
    expect(mockApplyStickiness).toHaveBeenCalledWith(ragResults, new Set());

    // Clear and call again
    agent.clearHistory();
    mockApplyStickiness.mockClear();

    await agent.processInput('Hello again');
    // After clearHistory, previousRAGFacts should be empty again
    expect(mockApplyStickiness).toHaveBeenCalledWith(ragResults, new Set());
  });

  describe('step-limit exhaustion detection', () => {
    it('getStepLimitHit returns non-null when generateText exhausts maxSteps with tool-calls', async () => {
      const config = makeConfig({ maxSteps: 3 });
      mockGenerateText.mockResolvedValue({
        finishReason: 'tool-calls',
        steps: [{}, {}, {}], // length === maxSteps
        response: { messages: [{ role: 'assistant', content: 'Partial' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });
      const agent = new Agent(config, toolOptions, store);
      await agent.processInput('Do many things');
      const hit = agent.getStepLimitHit();
      expect(hit).not.toBeNull();
      expect(hit!.currentLimit).toBe(3);
      expect(hit!.hitCount).toBe(1);
    });

    it('getStepLimitHit returns null on normal completion', async () => {
      mockGenerateText.mockResolvedValue({
        finishReason: 'stop',
        steps: [{}],
        response: { messages: [{ role: 'assistant', content: 'Done' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });
      const agent = new Agent(makeConfig(), toolOptions, store);
      await agent.processInput('Hello');
      expect(agent.getStepLimitHit()).toBeNull();
    });

    it('hitCount increments across multiple exhaustion calls', async () => {
      const config = makeConfig({ maxSteps: 2 });
      mockGenerateText.mockResolvedValue({
        finishReason: 'tool-calls',
        steps: [{}, {}],
        response: { messages: [{ role: 'assistant', content: 'Partial' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });
      const agent = new Agent(config, toolOptions, store);

      await agent.processInput('First');
      expect(agent.getStepLimitHit()!.hitCount).toBe(1);

      await agent.processInput('Second');
      expect(agent.getStepLimitHit()!.hitCount).toBe(2);
    });

    it('clearHistory resets step limit hit state', async () => {
      const config = makeConfig({ maxSteps: 2 });
      mockGenerateText.mockResolvedValue({
        finishReason: 'tool-calls',
        steps: [{}, {}],
        response: { messages: [{ role: 'assistant', content: 'Partial' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });
      const agent = new Agent(config, toolOptions, store);

      await agent.processInput('First');
      expect(agent.getStepLimitHit()).not.toBeNull();

      agent.clearHistory();
      expect(agent.getStepLimitHit()).toBeNull();
    });

    it('lastStepLimitHit resets at start of processInput (not stale from previous call)', async () => {
      const config = makeConfig({ maxSteps: 2 });

      // First call: hits the limit
      mockGenerateText.mockResolvedValueOnce({
        finishReason: 'tool-calls',
        steps: [{}, {}],
        response: { messages: [{ role: 'assistant', content: 'Partial' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });

      const agent = new Agent(config, toolOptions, store);
      await agent.processInput('First');
      expect(agent.getStepLimitHit()).not.toBeNull();

      // Second call: completes normally
      mockGenerateText.mockResolvedValueOnce({
        finishReason: 'stop',
        steps: [{}],
        response: { messages: [{ role: 'assistant', content: 'Done' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });

      await agent.processInput('Second');
      expect(agent.getStepLimitHit()).toBeNull();
    });
  });

  describe('coordinator (ReAct) mode', () => {
    it('omits plan, think, and evaluate tools when reactMode is false', async () => {
      mockGenerateText.mockResolvedValue({
        response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });
      const agent = new Agent(makeConfig({ reactMode: false }), toolOptions, store);
      await agent.processInput('Hello');
      const call = mockGenerateText.mock.calls[0][0];
      expect(call.tools).not.toHaveProperty('plan');
      expect(call.tools).not.toHaveProperty('think');
      expect(call.tools).not.toHaveProperty('evaluate');
    });

    it('includes plan, think, and evaluate tools when reactMode is true', async () => {
      mockGenerateText.mockResolvedValue({
        response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });
      const agent = new Agent(makeConfig({ reactMode: true }), toolOptions, store);
      await agent.processInput('Hello');
      const call = mockGenerateText.mock.calls[0][0];
      expect(call.tools).toHaveProperty('plan');
      expect(call.tools).toHaveProperty('think');
      expect(call.tools).toHaveProperty('evaluate');
    });

    it('triples maxSteps when reactMode is true', async () => {
      mockGenerateText.mockResolvedValue({
        response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });
      const agent = new Agent(makeConfig({ reactMode: true, maxSteps: 10 }), toolOptions, store);
      await agent.processInput('Hello');
      const call = mockGenerateText.mock.calls[0][0];
      expect(call.maxSteps).toBe(30);
    });

    it('uses base maxSteps when reactMode is false', async () => {
      mockGenerateText.mockResolvedValue({
        response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });
      const agent = new Agent(makeConfig({ reactMode: false, maxSteps: 10 }), toolOptions, store);
      await agent.processInput('Hello');
      const call = mockGenerateText.mock.calls[0][0];
      expect(call.maxSteps).toBe(10);
    });

    describe('plan-enforcement loop', () => {
      const baseResult = {
        finishReason: 'stop',
        steps: [],
        response: { messages: [{ role: 'assistant', content: 'ok' }] },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };

      it('re-prompts once when plan still has unresolved steps, then exits when resolved', async () => {
        const agent = new Agent(makeConfig({ reactMode: true }), toolOptions, store);
        const planStore = (agent as unknown as { planStore: any }).planStore;
        let call = 0;
        mockGenerateText.mockImplementation(async () => {
          call++;
          if (call === 1) planStore.create(['gather', 'summarize']);
          else {
            planStore.update(1, 'done', 'got data');
            planStore.update(2, 'done', 'wrote summary');
          }
          return baseResult;
        });
        await agent.processInput('do stuff');
        expect(mockGenerateText).toHaveBeenCalledTimes(2);
        expect(vi.mocked(printWarning)).toHaveBeenCalledWith(
          expect.stringContaining('Plan has 2 unresolved step'),
        );
      });

      it('does not re-prompt when plan is already complete', async () => {
        const agent = new Agent(makeConfig({ reactMode: true }), toolOptions, store);
        const planStore = (agent as unknown as { planStore: any }).planStore;
        mockGenerateText.mockImplementation(async () => {
          if (planStore.view().length === 0) {
            planStore.create(['only step']);
            planStore.update(1, 'done', 'finished');
          }
          return baseResult;
        });
        await agent.processInput('hi');
        expect(mockGenerateText).toHaveBeenCalledTimes(1);
      });

      it('does not re-prompt when no plan was created', async () => {
        const agent = new Agent(makeConfig({ reactMode: true }), toolOptions, store);
        mockGenerateText.mockResolvedValue(baseResult);
        await agent.processInput('trivial');
        expect(mockGenerateText).toHaveBeenCalledTimes(1);
      });

      it('stops re-prompting when abort fires mid-loop', async () => {
        const agent = new Agent(makeConfig({ reactMode: true }), toolOptions, store);
        const planStore = (agent as unknown as { planStore: any }).planStore;
        let call = 0;
        mockGenerateText.mockImplementation(async () => {
          call++;
          if (call === 1) {
            planStore.create(['never resolved']);
            agent.abort();
          }
          return baseResult;
        });
        await agent.processInput('x');
        expect(mockGenerateText).toHaveBeenCalledTimes(1);
      });

      it('exhausts retries, auto-cancels remaining steps, and emits info when plan never resolves', async () => {
        const agent = new Agent(makeConfig({ reactMode: true }), toolOptions, store);
        const planStore = (agent as unknown as { planStore: any }).planStore;
        mockGenerateText.mockImplementation(async () => {
          if (planStore.view().length === 0) planStore.create(['stuck']);
          return baseResult;
        });
        await agent.processInput('try');
        expect(mockGenerateText).toHaveBeenCalledTimes(3);
        expect(vi.mocked(printInfo)).toHaveBeenCalledWith(
          expect.stringContaining('Auto-cancelled'),
        );
        const steps = planStore.view();
        expect(steps.every((s: { status: string }) => s.status === 'cancelled')).toBe(true);
        expect(steps[0].note).toContain('enforcement retries exhausted');
      });

      it('does not re-prompt when reactMode is false even with unresolved steps', async () => {
        const agent = new Agent(makeConfig({ reactMode: false }), toolOptions, store);
        const planStore = (agent as unknown as { planStore: any }).planStore;
        mockGenerateText.mockImplementation(async () => {
          if (planStore.view().length === 0) planStore.create(['unresolved']);
          return baseResult;
        });
        await agent.processInput('hi');
        expect(mockGenerateText).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('image attachments', () => {
    const mockImageAttachment = {
      path: '/tmp/test.png',
      mimeType: 'image/png',
      data: Buffer.from('fake-png-data'),
    };

    it('processInput with images builds multipart UserContent', async () => {
      mockGenerateText.mockResolvedValue({
        response: { messages: [{ role: 'assistant', content: 'I see an image.' }] },
        usage: { promptTokens: 200, completionTokens: 50, totalTokens: 250 },
      });
      const agent = new Agent(makeConfig(), toolOptions, store);
      await agent.processInput('Describe this', [mockImageAttachment]);

      const call = mockGenerateText.mock.calls[0][0];
      const userMsg = call.messages.find((m: any) => m.role === 'user');
      // Content should be an array with text + image parts
      expect(Array.isArray(userMsg.content)).toBe(true);
      expect(userMsg.content).toHaveLength(2);
      expect(userMsg.content[0].type).toBe('text');
      expect(userMsg.content[1].type).toBe('image');
      expect(userMsg.content[1].mimeType).toBe('image/png');
    });

    it('processInput with images timestamps the text part', async () => {
      mockGenerateText.mockResolvedValue({
        response: { messages: [{ role: 'assistant', content: 'Done' }] },
        usage: { promptTokens: 200, completionTokens: 50, totalTokens: 250 },
      });
      const agent = new Agent(makeConfig(), toolOptions, store);
      await agent.processInput('What is this?', [mockImageAttachment]);

      const call = mockGenerateText.mock.calls[0][0];
      const userMsg = call.messages.find((m: any) => m.role === 'user');
      // The text part should have a timestamp prefix
      expect(userMsg.content[0].text).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] What is this\?$/,
      );
    });

    it('processInput without images still sends a string', async () => {
      mockGenerateText.mockResolvedValue({
        response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });
      const agent = new Agent(makeConfig(), toolOptions, store);
      await agent.processInput('Hello');

      const call = mockGenerateText.mock.calls[0][0];
      const userMsg = call.messages.find((m: any) => m.role === 'user');
      expect(typeof userMsg.content).toBe('string');
    });

    it('processInput with multiple images attaches all of them', async () => {
      mockGenerateText.mockResolvedValue({
        response: { messages: [{ role: 'assistant', content: 'I see two images.' }] },
        usage: { promptTokens: 300, completionTokens: 50, totalTokens: 350 },
      });
      const secondImage = {
        path: '/tmp/photo.jpg',
        mimeType: 'image/jpeg',
        data: Buffer.from('fake-jpg-data'),
      };
      const agent = new Agent(makeConfig(), toolOptions, store);
      await agent.processInput('Compare these', [mockImageAttachment, secondImage]);

      const call = mockGenerateText.mock.calls[0][0];
      const userMsg = call.messages.find((m: any) => m.role === 'user');
      expect(Array.isArray(userMsg.content)).toBe(true);
      expect(userMsg.content).toHaveLength(3); // 1 text + 2 images
      expect(userMsg.content[0].type).toBe('text');
      expect(userMsg.content[1].type).toBe('image');
      expect(userMsg.content[2].type).toBe('image');
      expect(userMsg.content[2].mimeType).toBe('image/jpeg');
    });
  });
});
