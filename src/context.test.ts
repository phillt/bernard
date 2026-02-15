import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CoreMessage } from 'ai';
import {
  getContextWindow,
  shouldCompress,
  serializeMessages,
  countRecentMessages,
  compressHistory,
  extractFacts,
  extractDomainFacts,
  truncateToolResults,
  estimateHistoryTokens,
  emergencyTruncate,
  isTokenOverflowError,
  MODEL_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  COMPRESSION_THRESHOLD,
} from './context.js';
import type { BernardConfig } from './config.js';
import type { RAGStore } from './rag.js';

vi.mock('./providers/index.js', () => ({
  getModel: vi.fn(() => ({ modelId: 'mock' })),
}));

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
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
    ragEnabled: true,
    anthropicApiKey: 'sk-test',
    ...overrides,
  };
}

describe('getContextWindow', () => {
  it('returns correct value for known Anthropic model', () => {
    expect(getContextWindow('claude-sonnet-4-5-20250929')).toBe(200_000);
  });

  it('returns correct value for known OpenAI model', () => {
    expect(getContextWindow('gpt-4o')).toBe(128_000);
  });

  it('returns correct value for gpt-4.1 (1M)', () => {
    expect(getContextWindow('gpt-4.1')).toBe(1_000_000);
  });

  it('returns correct value for xAI model', () => {
    expect(getContextWindow('grok-3')).toBe(131_072);
  });

  it('falls back to DEFAULT_CONTEXT_WINDOW for unknown models', () => {
    expect(getContextWindow('unknown-model-xyz')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(getContextWindow('unknown-model-xyz')).toBe(128_000);
  });
});

describe('shouldCompress', () => {
  it('returns false when well below threshold', () => {
    // 200k window * 0.75 = 150k threshold
    expect(shouldCompress(50_000, 1_000, 'claude-sonnet-4-5-20250929')).toBe(false);
  });

  it('returns true when above threshold', () => {
    // 200k * 0.75 = 150k, 140k + 15k = 155k > 150k
    expect(shouldCompress(140_000, 15_000, 'claude-sonnet-4-5-20250929')).toBe(true);
  });

  it('returns true at exactly the threshold boundary', () => {
    const window = getContextWindow('gpt-4o'); // 128k
    const threshold = window * COMPRESSION_THRESHOLD; // 96k
    // threshold + 1 should trigger
    expect(shouldCompress(threshold, 1, 'gpt-4o')).toBe(true);
  });

  it('returns false just below threshold', () => {
    const window = getContextWindow('gpt-4o'); // 128k
    const threshold = window * COMPRESSION_THRESHOLD; // 96k
    expect(shouldCompress(threshold - 1, 0, 'gpt-4o')).toBe(false);
  });

  it('uses fallback window for unknown models', () => {
    // 128k * 0.75 = 96k
    expect(shouldCompress(90_000, 10_000, 'mystery-model')).toBe(true);
    expect(shouldCompress(50_000, 10_000, 'mystery-model')).toBe(false);
  });
});

describe('serializeMessages', () => {
  it('serializes user messages', () => {
    const msgs: CoreMessage[] = [
      { role: 'user', content: 'Hello there' },
    ];
    expect(serializeMessages(msgs)).toBe('User: Hello there');
  });

  it('serializes assistant messages', () => {
    const msgs: CoreMessage[] = [
      { role: 'assistant', content: 'Hi! How can I help?' },
    ];
    expect(serializeMessages(msgs)).toBe('Assistant: Hi! How can I help?');
  });

  it('serializes mixed conversation', () => {
    const msgs: CoreMessage[] = [
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: '4' },
      { role: 'user', content: 'Thanks' },
    ];
    const result = serializeMessages(msgs);
    expect(result).toContain('User: What is 2+2?');
    expect(result).toContain('Assistant: 4');
    expect(result).toContain('User: Thanks');
  });

  it('handles tool-call parts in assistant messages', () => {
    const msgs: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'shell', args: { command: 'ls' } },
        ],
      },
    ];
    const result = serializeMessages(msgs);
    expect(result).toContain('shell');
    expect(result).toContain('ls');
  });

  it('handles tool role messages', () => {
    const msgs: CoreMessage[] = [
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'tc1', result: 'file1.ts\nfile2.ts' },
        ],
      },
    ];
    const result = serializeMessages(msgs);
    expect(result).toContain('file1.ts');
  });

  it('returns empty string for empty array', () => {
    expect(serializeMessages([])).toBe('');
  });
});

describe('countRecentMessages', () => {
  it('returns 0 when history has fewer turns than turnsToKeep', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
    ];
    expect(countRecentMessages(history, 4)).toBe(0);
  });

  it('finds correct split point with exactly turnsToKeep turns', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'resp1' },
      { role: 'user', content: 'msg2' },
      { role: 'assistant', content: 'resp2' },
      { role: 'user', content: 'msg3' },
      { role: 'assistant', content: 'resp3' },
      { role: 'user', content: 'msg4' },
      { role: 'assistant', content: 'resp4' },
    ];
    // 4 user turns exactly = no compression
    expect(countRecentMessages(history, 4)).toBe(0);
  });

  it('splits when there are more turns than turnsToKeep', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'old1' },
      { role: 'assistant', content: 'old-resp1' },
      { role: 'user', content: 'old2' },
      { role: 'assistant', content: 'old-resp2' },
      { role: 'user', content: 'recent1' },
      { role: 'assistant', content: 'recent-resp1' },
      { role: 'user', content: 'recent2' },
      { role: 'assistant', content: 'recent-resp2' },
      { role: 'user', content: 'recent3' },
      { role: 'assistant', content: 'recent-resp3' },
      { role: 'user', content: 'recent4' },
      { role: 'assistant', content: 'recent-resp4' },
    ];
    const splitIndex = countRecentMessages(history, 4);
    // Should keep the last 4 user turns: recent1..recent4
    // recent1 starts at index 4
    expect(splitIndex).toBe(4);
    expect(history[splitIndex].content).toBe('recent1');
  });

  it('handles tool messages between user/assistant', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'running tool' },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc1', result: 'output' }] },
      { role: 'assistant', content: 'old result' },
      { role: 'user', content: 'recent1' },
      { role: 'assistant', content: 'resp1' },
      { role: 'user', content: 'recent2' },
    ];
    const splitIndex = countRecentMessages(history, 2);
    expect(splitIndex).toBe(4); // starts at 'recent1'
  });
});

describe('extractDomainFacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls LLM once per domain (3 calls for 3 domains)', async () => {
    mockGenerateText.mockResolvedValue({
      text: '["some fact"]',
    });

    await extractDomainFacts('User: test\nAssistant: ok', makeConfig());
    expect(mockGenerateText).toHaveBeenCalledTimes(3);
  });

  it('returns domain-tagged facts', async () => {
    let callIndex = 0;
    mockGenerateText.mockImplementation(async (opts: any) => {
      callIndex++;
      // Each domain produces a different fact
      if (opts.system.includes('tool-usage pattern')) {
        return { text: '["npm run build compiles project"]' };
      }
      if (opts.system.includes('user preference')) {
        return { text: '["User prefers dark mode"]' };
      }
      return { text: '["Project uses TypeScript"]' };
    });

    const results = await extractDomainFacts('User: test\nAssistant: ok', makeConfig());
    expect(results.length).toBe(3);

    const domains = results.map(r => r.domain).sort();
    expect(domains).toEqual(['general', 'tool-usage', 'user-preferences']);

    const toolFacts = results.find(r => r.domain === 'tool-usage');
    expect(toolFacts?.facts).toEqual(['npm run build compiles project']);
  });

  it('handles partial failures (one domain errors, others succeed)', async () => {
    let callCount = 0;
    mockGenerateText.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error('API rate limit');
      }
      return { text: '["a fact"]' };
    });

    const results = await extractDomainFacts('User: test\nAssistant: ok', makeConfig());
    // 2 of 3 domains should succeed
    expect(results.length).toBe(2);
  });

  it('returns empty for empty input', async () => {
    const results = await extractDomainFacts('', makeConfig());
    expect(results).toEqual([]);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('returns empty for whitespace-only input', async () => {
    const results = await extractDomainFacts('   ', makeConfig());
    expect(results).toEqual([]);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('filters out domains with no facts', async () => {
    mockGenerateText.mockImplementation(async (opts: any) => {
      if (opts.system.includes('tool-usage pattern')) {
        return { text: '[]' };
      }
      return { text: '["a fact"]' };
    });

    const results = await extractDomainFacts('User: test\nAssistant: ok', makeConfig());
    const domains = results.map(r => r.domain);
    expect(domains).not.toContain('tool-usage');
  });

  it('filters facts exceeding max length', async () => {
    const longFact = 'x'.repeat(501);
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify(['short fact', longFact]),
    });

    const results = await extractDomainFacts('User: test', makeConfig());
    for (const r of results) {
      for (const fact of r.facts) {
        expect(fact.length).toBeLessThanOrEqual(500);
      }
    }
  });
});

describe('extractFacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns flat array from all domains (backward compat)', async () => {
    mockGenerateText.mockResolvedValue({
      text: '["fact from this domain"]',
    });

    const facts = await extractFacts('User: test\nAssistant: ok', makeConfig());
    // 3 domains, each producing 1 fact = 3 total
    expect(facts).toHaveLength(3);
    expect(facts.every(f => f === 'fact from this domain')).toBe(true);
  });

  it('returns empty array for empty input', async () => {
    const facts = await extractFacts('', makeConfig());
    expect(facts).toEqual([]);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('returns empty array when all domains fail', async () => {
    mockGenerateText.mockRejectedValue(new Error('API error'));
    const facts = await extractFacts('some text', makeConfig());
    expect(facts).toEqual([]);
  });

  it('handles markdown code fence in response', async () => {
    mockGenerateText.mockResolvedValue({
      text: '```json\n["fact one", "fact two"]\n```',
    });

    const facts = await extractFacts('some conversation', makeConfig());
    expect(facts).toContain('fact one');
    expect(facts).toContain('fact two');
  });
});

describe('compressHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns summary + recent messages on success', async () => {
    mockGenerateText.mockResolvedValue({
      text: '- User asked about files\n- Assistant listed directory contents',
    });

    const history: CoreMessage[] = [
      { role: 'user', content: 'old1' },
      { role: 'assistant', content: 'old-resp1' },
      { role: 'user', content: 'old2' },
      { role: 'assistant', content: 'old-resp2' },
      { role: 'user', content: 'old3' },
      { role: 'assistant', content: 'old-resp3' },
      // These 4 recent turns should be kept
      { role: 'user', content: 'recent1' },
      { role: 'assistant', content: 'recent-resp1' },
      { role: 'user', content: 'recent2' },
      { role: 'assistant', content: 'recent-resp2' },
      { role: 'user', content: 'recent3' },
      { role: 'assistant', content: 'recent-resp3' },
      { role: 'user', content: 'recent4' },
      { role: 'assistant', content: 'recent-resp4' },
    ];

    const result = await compressHistory(history, makeConfig());

    // Should have: summary message + ack message + 8 recent messages
    expect(result.length).toBe(10);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('[Context Summary');
    expect(result[0].content).toContain('User asked about files');
    expect(result[1].role).toBe('assistant');
    expect(result[1].content).toContain('Understood');
    // Recent messages preserved
    expect(result[2].content).toBe('recent1');
    expect(result[result.length - 1].content).toBe('recent-resp4');
  });

  it('returns original history when not enough turns to compress', async () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'resp1' },
      { role: 'user', content: 'msg2' },
      { role: 'assistant', content: 'resp2' },
    ];

    const result = await compressHistory(history, makeConfig());
    expect(result).toEqual(history);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('returns original history on LLM error (graceful degradation)', async () => {
    mockGenerateText.mockRejectedValue(new Error('API error'));

    const history: CoreMessage[] = [];
    // Create enough history to trigger compression
    for (let i = 0; i < 6; i++) {
      history.push({ role: 'user', content: `msg${i}` });
      history.push({ role: 'assistant', content: `resp${i}` });
    }

    const result = await compressHistory(history, makeConfig());
    expect(result).toEqual(history);
  });

  it('returns original history when summary is empty', async () => {
    mockGenerateText.mockResolvedValue({ text: '' });

    const history: CoreMessage[] = [];
    for (let i = 0; i < 6; i++) {
      history.push({ role: 'user', content: `msg${i}` });
      history.push({ role: 'assistant', content: `resp${i}` });
    }

    const result = await compressHistory(history, makeConfig());
    expect(result).toEqual(history);
  });

  it('stores facts with domain tags when ragStore is provided', async () => {
    mockGenerateText.mockImplementation(async (opts: any) => {
      // Summarization call has SUMMARIZATION_PROMPT
      if (opts.system.includes('conversation summarizer')) {
        return { text: '- Summary of conversation' };
      }
      // Domain extraction calls
      if (opts.system.includes('tool-usage pattern')) {
        return { text: '["npm run build worked"]' };
      }
      if (opts.system.includes('user preference')) {
        return { text: '["User likes dark mode"]' };
      }
      return { text: '["Project uses TypeScript"]' };
    });

    const mockRagStore = {
      addFacts: vi.fn().mockResolvedValue(1),
    } as unknown as RAGStore;

    const history: CoreMessage[] = [];
    for (let i = 0; i < 6; i++) {
      history.push({ role: 'user', content: `msg${i}` });
      history.push({ role: 'assistant', content: `resp${i}` });
    }

    const result = await compressHistory(history, makeConfig(), mockRagStore);

    // Should call addFacts with domain tags
    expect(mockRagStore.addFacts).toHaveBeenCalledWith(
      expect.any(Array),
      'compression',
      'tool-usage',
    );
    expect(mockRagStore.addFacts).toHaveBeenCalledWith(
      expect.any(Array),
      'compression',
      'user-preferences',
    );
    expect(mockRagStore.addFacts).toHaveBeenCalledWith(
      expect.any(Array),
      'compression',
      'general',
    );
    // Result should still be compressed
    expect(result[0].content).toContain('[Context Summary');
  });

  it('works without ragStore (backward compatible)', async () => {
    mockGenerateText.mockResolvedValue({
      text: '- Summary',
    });

    const history: CoreMessage[] = [];
    for (let i = 0; i < 6; i++) {
      history.push({ role: 'user', content: `msg${i}` });
      history.push({ role: 'assistant', content: `resp${i}` });
    }

    const result = await compressHistory(history, makeConfig());
    // Only summarization call, no extraction
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(result[0].content).toContain('[Context Summary');
  });
});

describe('truncateToolResults', () => {
  it('truncates large tool-result content to maxChars', () => {
    const bigResult = 'x'.repeat(20_000);
    const messages: CoreMessage[] = [
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'tc1', result: bigResult },
        ],
      },
    ];
    const result = truncateToolResults(messages, 10_000);
    const part = (result[0].content as any[])[0];
    expect(part.result.length).toBeLessThan(bigResult.length);
    expect(part.result).toContain('...[truncated from 20000 to 10000 chars]');
  });

  it('preserves small tool results unchanged', () => {
    const smallResult = 'hello world';
    const messages: CoreMessage[] = [
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'tc1', result: smallResult },
        ],
      },
    ];
    const result = truncateToolResults(messages, 10_000);
    const part = (result[0].content as any[])[0];
    expect(part.result).toBe(smallResult);
  });

  it('passes non-tool messages through unchanged', () => {
    const messages: CoreMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const result = truncateToolResults(messages, 100);
    expect(result).toEqual(messages);
  });

  it('appends truncation notice with original size', () => {
    const messages: CoreMessage[] = [
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'tc1', result: 'a'.repeat(500) },
        ],
      },
    ];
    const result = truncateToolResults(messages, 100);
    const part = (result[0].content as any[])[0];
    expect(part.result).toContain('truncated from 500 to 100 chars');
  });

  it('does not mutate original messages', () => {
    const original = 'x'.repeat(500);
    const messages: CoreMessage[] = [
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'tc1', result: original },
        ],
      },
    ];
    truncateToolResults(messages, 100);
    const part = (messages[0].content as any[])[0];
    expect(part.result).toBe(original);
  });
});

describe('estimateHistoryTokens', () => {
  it('returns reasonable estimates for string content', () => {
    const messages: CoreMessage[] = [
      { role: 'user', content: 'Hello world' },
    ];
    const tokens = estimateHistoryTokens(messages);
    // "Hello world" is 11 chars + JSON quotes = 13 chars. 13 / 3.6 ≈ 4
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });

  it('handles tool-call and tool-result messages', () => {
    const messages: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'shell', args: { command: 'ls -la' } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'tc1', result: 'file1.ts\nfile2.ts' },
        ],
      },
    ];
    const tokens = estimateHistoryTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('scales roughly with content size', () => {
    const small: CoreMessage[] = [{ role: 'user', content: 'hi' }];
    const large: CoreMessage[] = [{ role: 'user', content: 'x'.repeat(10_000) }];
    const smallTokens = estimateHistoryTokens(small);
    const largeTokens = estimateHistoryTokens(large);
    expect(largeTokens).toBeGreaterThan(smallTokens * 100);
  });
});

describe('emergencyTruncate', () => {
  it('drops oldest messages until under budget', () => {
    const history: CoreMessage[] = [];
    for (let i = 0; i < 20; i++) {
      history.push({ role: 'user', content: `message ${i} ${'x'.repeat(1000)}` });
      history.push({ role: 'assistant', content: `response ${i} ${'y'.repeat(1000)}` });
    }
    // Small budget that can't fit everything
    const result = emergencyTruncate(history, 5000, 'system prompt');
    expect(result.length).toBeLessThan(history.length);
    // Should have truncation notice
    expect(result[0].content).toContain('truncated to fit context window');
    expect(result[1].content).toContain('Understood');
  });

  it('preserves at least 2 messages', () => {
    const history: CoreMessage[] = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: 'user', content: `msg ${i} ${'x'.repeat(5000)}` });
      history.push({ role: 'assistant', content: `resp ${i} ${'y'.repeat(5000)}` });
    }
    // Very small budget
    const result = emergencyTruncate(history, 100, 'system');
    // notice + ack + at least 2 original messages
    expect(result.length).toBeGreaterThanOrEqual(4);
    // Last two messages from original should be present
    expect(result[result.length - 1].content).toContain('resp 9');
    expect(result[result.length - 2].content).toContain('msg 9');
  });

  it('prepends truncation notice', () => {
    const history: CoreMessage[] = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: 'user', content: `msg ${i} ${'x'.repeat(1000)}` });
      history.push({ role: 'assistant', content: `resp ${i}` });
    }
    const result = emergencyTruncate(history, 2000, 'system');
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('truncated to fit context window');
    expect(result[1].role).toBe('assistant');
    expect(result[1].content).toContain('Understood');
  });

  it('returns original history when everything fits', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const result = emergencyTruncate(history, 100_000, 'system');
    expect(result).toEqual(history);
  });

  it('never starts kept messages with a tool or assistant message', () => {
    // Build history where the natural cutoff would land on assistant/tool pair
    const history: CoreMessage[] = [
      { role: 'user', content: `old msg ${'x'.repeat(2000)}` },
      { role: 'assistant', content: `old resp ${'y'.repeat(2000)}` },
      // This assistant+tool pair could be orphaned if cutoff lands here
      { role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'tc1', toolName: 'shell', args: { command: 'ls' } },
      ] as any },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'tc1', result: 'file1.ts' },
      ] as any },
      { role: 'user', content: 'recent msg' },
      { role: 'assistant', content: 'recent resp' },
    ];

    // Budget that can't fit everything but can fit the last few messages
    const result = emergencyTruncate(history, 3000, 'system prompt');

    // Filter out the synthetic notice/ack pair
    const keptOriginal = result.filter(
      m => !(typeof m.content === 'string' && (
        m.content.includes('truncated to fit context window') ||
        m.content.includes('Continuing with limited context')
      )),
    );

    // The first kept original message must be a user message
    if (keptOriginal.length > 0) {
      expect(keptOriginal[0].role).toBe('user');
    }
  });

  it('aligns backward to user boundary instead of forward, preserving min-keep', () => {
    // History ending with assistant+tool, then assistant — no trailing user message.
    // A forward scan would skip past the last 2 messages, violating min-keep.
    const history: CoreMessage[] = [
      { role: 'user', content: `u1 ${'x'.repeat(2000)}` },
      { role: 'assistant', content: `a1 ${'y'.repeat(2000)}` },
      { role: 'user', content: `u2 ${'x'.repeat(2000)}` },
      { role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'tc1', toolName: 'shell', args: { command: 'ls' } },
      ] as any },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'tc1', result: 'output' },
      ] as any },
      { role: 'assistant', content: 'final response' },
    ];

    // Tiny budget forces min-keep (last 2 messages)
    const result = emergencyTruncate(history, 100, 'system');
    // Should include at least the truncation notice pair + kept messages
    expect(result.length).toBeGreaterThanOrEqual(4);
    // The first kept original message should be a user, found by backward scan
    const keptOriginal = result.filter(
      m => !(typeof m.content === 'string' && (
        m.content.includes('truncated to fit context window') ||
        m.content.includes('Continuing with limited context')
      )),
    );
    expect(keptOriginal.length).toBeGreaterThanOrEqual(2);
    expect(keptOriginal[0].role).toBe('user');
  });
});

describe('isTokenOverflowError', () => {
  it('matches Anthropic-style error', () => {
    expect(isTokenOverflowError(
      "This model's maximum prompt length is 131072 but the request contains 134090 tokens"
    )).toBe(true);
  });

  it('matches OpenAI-style error', () => {
    expect(isTokenOverflowError(
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens."
    )).toBe(true);
    expect(isTokenOverflowError(
      "context length exceeded"
    )).toBe(true);
  });

  it('matches prompt too long error', () => {
    expect(isTokenOverflowError('prompt too long')).toBe(true);
  });

  it('matches token limit error', () => {
    expect(isTokenOverflowError('Request exceeds token limit')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isTokenOverflowError('API rate limit exceeded')).toBe(false);
    expect(isTokenOverflowError('Network timeout')).toBe(false);
    expect(isTokenOverflowError('Invalid API key')).toBe(false);
  });
});
