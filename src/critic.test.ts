import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSystemPrompt, Agent } from './agent.js';
import { printCriticVerdict } from './output.js';
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
  printCriticStart: vi.fn(),
  printCriticVerdict: vi.fn(),
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
}));

vi.mock('./rag-query.js', () => ({
  extractRecentUserTexts: vi.fn((): string[] => []),
  extractRecentToolContext: vi.fn((): string => ''),
  buildRAGQuery: vi.fn((input: string) => input),
  applyStickiness: vi.fn((results: any) => results),
}));

vi.mock('./tools/subagent.js', () => ({
  createSubAgentTool: vi.fn(() => ({ description: 'mock', execute: vi.fn() })),
}));

vi.mock('./tools/task.js', () => ({
  createTaskTool: vi.fn(() => ({ description: 'mock', execute: vi.fn() })),
  TASK_SYSTEM_PROMPT: 'task prompt',
  wrapTaskResult: vi.fn((text: string) => ({ status: 'success', output: text })),
}));

vi.mock('./tools/specialist-run.js', () => ({
  createSpecialistRunTool: vi.fn(() => ({ description: 'mock', execute: vi.fn() })),
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
    ragEnabled: true,
    theme: 'bernard',
    criticMode: false,
    anthropicApiKey: 'sk-test',
    ...overrides,
  };
}

const toolOptions = { shellTimeout: 30000, confirmDangerous: async () => true };

describe('critic mode', () => {
  let store: MemoryStore;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    store = new MemoryStore();
  });

  describe('buildSystemPrompt with criticMode', () => {
    it('includes Reliability Mode prompt when criticMode is true', () => {
      const prompt = buildSystemPrompt(makeConfig({ criticMode: true }), store);
      expect(prompt).toContain('Reliability Mode (Active)');
      expect(prompt).toContain('### Planning');
      expect(prompt).toContain('### Proactive Scratch Usage');
      expect(prompt).toContain('### Verification');
    });

    it('excludes Reliability Mode prompt when criticMode is false', () => {
      const prompt = buildSystemPrompt(makeConfig({ criticMode: false }), store);
      expect(prompt).not.toContain('Reliability Mode (Active)');
    });
  });

  describe('critic integration in processInput', () => {
    it('runs critic when criticMode is true and tool calls exist', async () => {
      // First call: main agent response with tool calls
      mockGenerateText
        .mockResolvedValueOnce({
          text: 'I created the file.',
          steps: [
            {
              toolCalls: [{ toolName: 'shell', args: { command: 'touch test.txt' } }],
              toolResults: [{ toolName: 'shell', result: '' }],
            },
          ],
          response: { messages: [] },
          usage: { promptTokens: 100, completionTokens: 50 },
        })
        // Second call: critic response
        .mockResolvedValueOnce({
          text: 'VERDICT: PASS\nAll claims supported by tool calls.',
          steps: [],
          response: { messages: [] },
          usage: { promptTokens: 50, completionTokens: 20 },
        });

      const agent = new Agent(makeConfig({ criticMode: true }), toolOptions, store);
      await agent.processInput('Create a file');

      // Should have been called twice: main + critic
      expect(mockGenerateText).toHaveBeenCalledTimes(2);

      // Second call should use critic system prompt
      const criticCall = mockGenerateText.mock.calls[1][0];
      expect(criticCall.system).toContain('verification agent');
      expect(criticCall.maxSteps).toBe(1);
      expect(criticCall.maxTokens).toBe(1024);
    });

    it('skips critic when criticMode is false', async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: 'Done.',
        steps: [
          {
            toolCalls: [{ toolName: 'shell', args: { command: 'ls' } }],
            toolResults: [{ toolName: 'shell', result: 'file.txt' }],
          },
        ],
        response: { messages: [] },
        usage: { promptTokens: 100, completionTokens: 50 },
      });

      const agent = new Agent(makeConfig({ criticMode: false }), toolOptions, store);
      await agent.processInput('List files');

      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('skips critic when no tool calls were made', async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: 'The answer is 42.',
        steps: [{ toolCalls: [], toolResults: [] }],
        response: { messages: [] },
        usage: { promptTokens: 100, completionTokens: 50 },
      });

      const agent = new Agent(makeConfig({ criticMode: true }), toolOptions, store);
      await agent.processInput('What is the meaning of life?');

      // Only one call — no critic needed
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('handles critic failure gracefully', async () => {
      mockGenerateText
        .mockResolvedValueOnce({
          text: 'Done.',
          steps: [
            {
              toolCalls: [{ toolName: 'shell', args: { command: 'echo hi' } }],
              toolResults: [{ toolName: 'shell', result: 'hi' }],
            },
          ],
          response: { messages: [] },
          usage: { promptTokens: 100, completionTokens: 50 },
        })
        .mockRejectedValueOnce(new Error('API error'));

      const agent = new Agent(makeConfig({ criticMode: true }), toolOptions, store);
      // Should not throw — critic failure is non-fatal
      await expect(agent.processInput('Say hi')).resolves.toBeUndefined();
    });
  });

  describe('printCriticVerdict', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('is called with critic output text', async () => {
      const { printCriticVerdict: mockVerdict } = await import('./output.js');

      mockGenerateText
        .mockResolvedValueOnce({
          text: 'I ran the command.',
          steps: [
            {
              toolCalls: [{ toolName: 'shell', args: { command: 'ls' } }],
              toolResults: [{ toolName: 'shell', result: 'file.txt' }],
            },
          ],
          response: { messages: [] },
          usage: { promptTokens: 100, completionTokens: 50 },
        })
        .mockResolvedValueOnce({
          text: 'VERDICT: PASS\nAll good.',
          steps: [],
          response: { messages: [] },
          usage: { promptTokens: 50, completionTokens: 20 },
        });

      const agent = new Agent(makeConfig({ criticMode: true }), toolOptions, store);
      await agent.processInput('list files');

      expect(mockVerdict).toHaveBeenCalledWith('VERDICT: PASS\nAll good.');
    });
  });
});
