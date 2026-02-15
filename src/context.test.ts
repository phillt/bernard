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
