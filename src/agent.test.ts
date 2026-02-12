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
}));

const mockGenerateText = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal() as any;
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

  it('includes today\'s date', () => {
    const prompt = buildSystemPrompt(makeConfig(), store);
    // Should contain a date-like string
    expect(prompt).toMatch(/\d{4}/);
  });

  it('includes provider and model', () => {
    const prompt = buildSystemPrompt(makeConfig({ provider: 'openai', model: 'gpt-4o' }), store);
    expect(prompt).toContain('openai');
    expect(prompt).toContain('gpt-4o');
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
    expect(prompt).not.toContain('Persistent Memory');
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
    expect(prompt).not.toContain('Scratch Notes');
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
    expect(call.messages).toEqual(
      expect.arrayContaining([{ role: 'user', content: 'Hello' }]),
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
});
