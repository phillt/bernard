import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSystemPrompt, Agent } from './agent.js';
import type { BernardConfig } from './config.js';
import { MemoryStore } from './memory.js';

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
}));

vi.mock('./output.js', () => ({
  printAssistantText: vi.fn(),
  printToolCall: vi.fn(),
  printToolResult: vi.fn(),
  printInfo: vi.fn(),
  startSpinner: vi.fn(),
  stopSpinner: vi.fn(),
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
const mockBuildRAGQuery = vi.fn((input: string) => input);
const mockApplyStickiness = vi.fn((results: any) => results);
vi.mock('./rag-query.js', () => ({
  extractRecentUserTexts: (...args: any[]) => mockExtractRecentUserTexts(...args),
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
    ragEnabled: true,
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

  it("includes today's date", () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    // Should contain a date-like string
    expect(prompt).toMatch(/\d{4}/);
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

  it('processInput passes user message in history', async () => {
    mockGenerateText.mockResolvedValue({
      response: { messages: [{ role: 'assistant', content: 'Hi!' }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    const agent = new Agent(makeConfig(), toolOptions, store);
    await agent.processInput('Hello');
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.messages).toEqual(expect.arrayContaining([{ role: 'user', content: 'Hello' }]));
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
    expect(call.tools.agent).toBe(mockSubAgentTool);
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
});
