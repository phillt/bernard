import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BernardConfig } from './config.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('./providers/index.js', () => ({
  getModel: vi.fn(() => ({ modelId: 'mock' })),
  getModelProfile: vi.fn(() => ({
    family: 'test',
    preferredFormat: 'minimal',
    stripCoTLanguage: false,
    wrapUserMessage: (m: string) => m,
    systemSuffix: '',
  })),
}));

vi.mock('./output.js', () => ({
  printCriticStart: vi.fn(),
  printCriticVerdict: vi.fn(),
  printCriticRetry: vi.fn(),
  printCriticReVerify: vi.fn(),
  parseCriticVerdict: vi.fn((text: string) => {
    const verdictMatch = text.match(/\bVERDICT:\s*(PASS|WARN|FAIL)\b/i);
    let verdict = 'UNKNOWN';
    let explanation = text.trim();
    if (verdictMatch) {
      verdict = verdictMatch[1].toUpperCase();
      explanation = text.replace(/^.*\bVERDICT:\s*(PASS|WARN|FAIL)\b[^\n]*/im, '').trim();
    }
    return { verdict, explanation };
  }),
  stopSpinner: vi.fn(),
}));

vi.mock('./context.js', () => ({
  truncateToolResults: vi.fn((messages: any) => messages),
}));

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
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
    criticMode: true,
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    anthropicApiKey: 'sk-test',
    ...overrides,
  };
}

describe('runPACLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateText.mockReset();
  });

  it('returns immediately when no tool calls', async () => {
    const { runPACLoop } = await import('./pac.js');

    const result = await runPACLoop({
      config: makeConfig(),
      userInput: 'What is 2+2?',
      initialResult: {
        text: 'The answer is 4.',
        steps: [{ toolCalls: [], toolResults: [] }],
        response: { messages: [] },
      },
      regenerate: vi.fn(),
    });

    expect(result.finalText).toBe('The answer is 4.');
    expect(result.criticPassed).toBe(true);
    expect(result.retriesUsed).toBe(0);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('returns on first PASS (retriesUsed: 0)', async () => {
    const { runPACLoop } = await import('./pac.js');

    // Critic returns PASS
    mockGenerateText.mockResolvedValueOnce({
      text: 'VERDICT: PASS\nAll good.',
      steps: [],
      response: { messages: [] },
      usage: { promptTokens: 50, completionTokens: 20 },
    });

    const result = await runPACLoop({
      config: makeConfig(),
      userInput: 'Create a file',
      initialResult: {
        text: 'I created the file.',
        steps: [
          {
            toolCalls: [{ toolName: 'shell', args: { command: 'touch test.txt' } }],
            toolResults: [{ toolName: 'shell', result: '' }],
          },
        ],
        response: { messages: [] },
      },
      regenerate: vi.fn(),
    });

    expect(result.criticPassed).toBe(true);
    expect(result.retriesUsed).toBe(0);
  });

  it('retries on FAIL, returns on second PASS (retriesUsed: 1)', async () => {
    const { runPACLoop } = await import('./pac.js');

    // First critic: FAIL
    mockGenerateText.mockResolvedValueOnce({
      text: 'VERDICT: FAIL\nFile not verified.',
      steps: [],
      response: { messages: [] },
      usage: { promptTokens: 50, completionTokens: 20 },
    });

    // Second critic (after retry): PASS
    mockGenerateText.mockResolvedValueOnce({
      text: 'VERDICT: PASS\nVerified now.',
      steps: [],
      response: { messages: [] },
      usage: { promptTokens: 50, completionTokens: 20 },
    });

    const regenerate = vi.fn().mockResolvedValueOnce({
      text: 'I verified the file exists.',
      steps: [
        {
          toolCalls: [{ toolName: 'shell', args: { command: 'ls test.txt' } }],
          toolResults: [{ toolName: 'shell', result: 'test.txt' }],
        },
      ],
      response: { messages: [] },
    });

    const result = await runPACLoop({
      config: makeConfig(),
      userInput: 'Create a file',
      initialResult: {
        text: 'I created the file.',
        steps: [
          {
            toolCalls: [{ toolName: 'shell', args: { command: 'touch test.txt' } }],
            toolResults: [{ toolName: 'shell', result: '' }],
          },
        ],
        response: { messages: [] },
      },
      regenerate,
    });

    expect(result.criticPassed).toBe(true);
    expect(result.retriesUsed).toBe(1);
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it('exhausts max retries on repeated FAIL', async () => {
    const { runPACLoop } = await import('./pac.js');

    // All critics return FAIL
    mockGenerateText
      .mockResolvedValueOnce({
        text: 'VERDICT: FAIL\nNot verified.',
        steps: [],
        response: { messages: [] },
      })
      .mockResolvedValueOnce({
        text: 'VERDICT: FAIL\nStill not verified.',
        steps: [],
        response: { messages: [] },
      })
      .mockResolvedValueOnce({
        text: 'VERDICT: FAIL\nGiving up.',
        steps: [],
        response: { messages: [] },
      });

    const regenerate = vi.fn().mockResolvedValue({
      text: 'Retried.',
      steps: [
        {
          toolCalls: [{ toolName: 'shell', args: { command: 'echo hi' } }],
          toolResults: [{ toolName: 'shell', result: 'hi' }],
        },
      ],
      response: { messages: [] },
    });

    const result = await runPACLoop({
      config: makeConfig(),
      userInput: 'Do something',
      initialResult: {
        text: 'Done.',
        steps: [
          {
            toolCalls: [{ toolName: 'shell', args: { command: 'echo hi' } }],
            toolResults: [{ toolName: 'shell', result: 'hi' }],
          },
        ],
        response: { messages: [] },
      },
      regenerate,
      maxRetries: 2,
    });

    expect(result.criticPassed).toBe(false);
    expect(result.retriesUsed).toBe(2);
    expect(regenerate).toHaveBeenCalledTimes(2);
  });

  it('handles regenerate errors gracefully', async () => {
    const { runPACLoop } = await import('./pac.js');

    // Critic returns FAIL
    mockGenerateText.mockResolvedValueOnce({
      text: 'VERDICT: FAIL\nBad.',
      steps: [],
      response: { messages: [] },
    });

    const regenerate = vi.fn().mockRejectedValueOnce(new Error('API error'));

    const result = await runPACLoop({
      config: makeConfig(),
      userInput: 'Do something',
      initialResult: {
        text: 'Done.',
        steps: [
          {
            toolCalls: [{ toolName: 'shell', args: { command: 'echo hi' } }],
            toolResults: [{ toolName: 'shell', result: 'hi' }],
          },
        ],
        response: { messages: [] },
      },
      regenerate,
    });

    expect(result.criticPassed).toBe(false);
    expect(result.retriesUsed).toBe(1);
  });

  it('handles critic error (null) gracefully', async () => {
    const { runPACLoop } = await import('./pac.js');

    // Critic throws error (returns null)
    mockGenerateText.mockRejectedValueOnce(new Error('Critic API error'));

    const result = await runPACLoop({
      config: makeConfig(),
      userInput: 'Do something',
      initialResult: {
        text: 'Done.',
        steps: [
          {
            toolCalls: [{ toolName: 'shell', args: { command: 'echo hi' } }],
            toolResults: [{ toolName: 'shell', result: 'hi' }],
          },
        ],
        response: { messages: [] },
      },
      regenerate: vi.fn(),
    });

    // Null critic result means pass (error is gracefully handled)
    expect(result.criticPassed).toBe(true);
    expect(result.retriesUsed).toBe(0);
  });
});
