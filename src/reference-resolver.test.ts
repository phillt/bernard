import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    wrapUserMessage: (m: string) => m,
    systemSuffix: '',
  })),
  getProviderOptions: vi.fn(() => undefined),
}));

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
}));

const generateTextMock = vi.fn();
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
  };
});

import {
  resolveReferences,
  renderResolvedBlock,
  shouldSkipResolver,
  deriveKeyFromReference,
  validateAgainstMemory,
  buildRecentTurnsBlock,
  stripToolResolvableTokens,
  RAG_SOURCE_KEY,
  type ResolvedEntry,
} from './reference-resolver.js';
import { MemoryStore } from './memory.js';
import type { RAGStore, RAGSearchResult } from './rag.js';
import type { BernardConfig } from './config.js';
import type { CoreMessage } from 'ai';

function makeConfig(): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-test',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    maxSteps: 25,
    ragEnabled: false,
    theme: 'bernard',
    criticMode: false,
    reactMode: false,
    toolDetails: false,
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    correctionEnabled: false,
  };
}

function makeStore(contents: Record<string, string>): MemoryStore {
  const store = new MemoryStore();
  vi.spyOn(store, 'getAllMemoryContents').mockReturnValue(new Map(Object.entries(contents)));
  vi.spyOn(store, 'listMemory').mockReturnValue(Object.keys(contents));
  return store;
}

function makeRagStore(
  search: (query: string) => Promise<RAGSearchResult[]> | RAGSearchResult[],
): RAGStore {
  return { search: vi.fn(async (q: string) => search(q)) } as unknown as RAGStore;
}

describe('deriveKeyFromReference', () => {
  it('strips leading possessive', () => {
    expect(deriveKeyFromReference('my brother')).toBe('brother');
  });

  it('strips leading demonstrative', () => {
    expect(deriveKeyFromReference('the car')).toBe('car');
  });

  it('joins multi-word names with dashes', () => {
    expect(deriveKeyFromReference('my brother Tom')).toBe('brother-tom');
  });

  it('sanitizes special characters', () => {
    expect(deriveKeyFromReference("my brother's car")).toBe('brothers-car');
  });
});

describe('shouldSkipResolver', () => {
  it('runs even when memory is empty if prompt has reference tokens (resolver may return unknown)', () => {
    expect(shouldSkipResolver('order my daughter sandwich')).toBe(false);
  });

  it('skips when prompt has no reference tokens', () => {
    expect(shouldSkipResolver('what is 2+2')).toBe(true);
  });

  it('runs when prompt has possessive + memory exists', () => {
    expect(shouldSkipResolver('order my daughter sandwich')).toBe(false);
  });

  it('skips single-word "the X" references (false-positive guard)', () => {
    expect(shouldSkipResolver('fix the bug')).toBe(true);
  });

  it('runs on multi-word "the X Y" references', () => {
    expect(shouldSkipResolver('fix the staging deploy')).toBe(false);
  });
});

describe('renderResolvedBlock', () => {
  it('returns empty string for no entries', () => {
    expect(renderResolvedBlock([])).toBe('');
  });

  it('renders entries with phrase, resolution, and source key', () => {
    const entries: ResolvedEntry[] = [
      { phrase: 'my daughter', resolvedTo: 'Allyson Schefflor', sourceKey: 'daughter-allyson' },
    ];
    const block = renderResolvedBlock(entries);
    expect(block).toContain('## Resolved References');
    expect(block).toContain('"my daughter" → Allyson Schefflor');
    expect(block).toContain('daughter-allyson');
    expect(block).toContain('hints, not rules');
  });
});

describe('resolveReferences', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('calls the resolver when memory is empty but prompt has references (may return unknown)', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ status: 'unknown', reference: 'my brother' }),
    });
    const store = makeStore({});
    const result = await resolveReferences('did my brother email me', store, makeConfig());
    expect(result.status).toBe('unknown');
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('returns noop when prompt has no reference patterns', async () => {
    const store = makeStore({ 'daughter-allyson': 'Allyson, 8' });
    const result = await resolveReferences('calculate 2+2', store, makeConfig());
    expect(result).toEqual({ status: 'noop' });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('returns unknown when named reference has no memory match', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ status: 'unknown', reference: 'my brother' }),
    });
    const store = makeStore({ 'daughter-allyson': 'Allyson, 8' });
    const result = await resolveReferences(
      'can you see if my brother emailed me',
      store,
      makeConfig(),
    );
    expect(result.status).toBe('unknown');
    if (result.status === 'unknown') {
      expect(result.reference).toBe('my brother');
    }
  });

  it('rejects unknown with empty reference', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ status: 'unknown', reference: '' }),
    });
    const store = makeStore({ x: 'y' });
    const result = await resolveReferences('call my mother', store, makeConfig());
    expect(result).toEqual({ status: 'noop' });
  });

  it('returns resolved entries on unambiguous case', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        status: 'resolved',
        entries: [
          {
            phrase: 'my daughter',
            resolvedTo: 'Allyson Schefflor',
            sourceKey: 'daughter-allyson',
          },
        ],
      }),
    });
    const store = makeStore({ 'daughter-allyson': 'Allyson Schefflor, age 8' });
    const result = await resolveReferences('order my daughter sandwich', store, makeConfig());
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].sourceKey).toBe('daughter-allyson');
    }
  });

  it('returns ambiguous with at least 2 candidates', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        status: 'ambiguous',
        reference: 'my daughter',
        candidates: [
          { label: 'Allyson', sourceKey: 'daughter-allyson', preview: 'age 8' },
          { label: 'Emma', sourceKey: 'daughter-emma', preview: 'age 11' },
        ],
      }),
    });
    const store = makeStore({
      'daughter-allyson': 'Allyson, 8',
      'daughter-emma': 'Emma, 11',
    });
    const result = await resolveReferences('call my daughter', store, makeConfig());
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.reference).toBe('my daughter');
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('filters out invented sourceKeys not present in memory', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        status: 'resolved',
        entries: [{ phrase: 'my cat', resolvedTo: 'Whiskers', sourceKey: 'cat-whiskers' }],
      }),
    });
    const store = makeStore({ 'daughter-allyson': 'Allyson' });
    const result = await resolveReferences('feed my cat', store, makeConfig());
    expect(result.status).toBe('noop');
  });

  it('downgrades ambiguous with <2 valid candidates to noop', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        status: 'ambiguous',
        reference: 'my daughter',
        candidates: [
          { label: 'Allyson', sourceKey: 'daughter-allyson', preview: 'age 8' },
          { label: 'Ghost', sourceKey: 'nonexistent-key', preview: 'fake' },
        ],
      }),
    });
    const store = makeStore({ 'daughter-allyson': 'Allyson' });
    const result = await resolveReferences('call my daughter', store, makeConfig());
    expect(result.status).toBe('noop');
  });

  it('returns noop on LLM error (fail-open)', async () => {
    generateTextMock.mockRejectedValue(new Error('network down'));
    const store = makeStore({ 'daughter-allyson': 'Allyson' });
    const result = await resolveReferences('order my daughter sandwich', store, makeConfig());
    expect(result).toEqual({ status: 'noop' });
  });

  it('returns noop on malformed JSON', async () => {
    generateTextMock.mockResolvedValue({ text: 'not json at all' });
    const store = makeStore({ 'daughter-allyson': 'Allyson' });
    const result = await resolveReferences('order my daughter sandwich', store, makeConfig());
    expect(result).toEqual({ status: 'noop' });
  });

  it('passes hints into the user message', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ status: 'noop' }),
    });
    const store = makeStore({ 'daughter-allyson': 'Allyson', 'daughter-emma': 'Emma' });
    const hints = new Map([['my daughter', 'daughter-allyson']]);
    await resolveReferences('call my daughter', store, makeConfig(), hints);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const callArgs = generateTextMock.mock.calls[0][0];
    const userContent = callArgs.messages[0].content;
    expect(userContent).toContain('Persisted hints');
    expect(userContent).toContain('"my daughter" → daughter-allyson');
  });
});

describe('resolveReferences with RAG', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('resolves a reference from a RAG fact with sourceKey "rag"', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        status: 'resolved',
        entries: [
          {
            phrase: 'aaron',
            resolvedTo: 'Aaron Nichols, PhoneBurner engineer',
            sourceKey: 'rag',
          },
        ],
      }),
    });
    const store = makeStore({});
    const rag = makeRagStore(() => [
      {
        fact: 'Aaron Nichols is a PhoneBurner engineer working on the web dialer.',
        similarity: 0.78,
        domain: 'people',
      },
    ]);
    const result = await resolveReferences(
      'assign the open PRs to aaron',
      store,
      makeConfig(),
      undefined,
      undefined,
      rag,
    );
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].sourceKey).toBe('rag');
      expect(result.entries[0].resolvedTo).toContain('Aaron Nichols');
    }
  });

  it('injects the RAG block into the user message when facts are returned', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ status: 'noop' }) });
    const store = makeStore({});
    const rag = makeRagStore(() => [
      {
        fact: 'Aaron Nichols is a PhoneBurner engineer.',
        similarity: 0.78,
        domain: 'people',
      },
    ]);
    await resolveReferences(
      'assign the open PRs to aaron',
      store,
      makeConfig(),
      undefined,
      undefined,
      rag,
    );
    const userContent = generateTextMock.mock.calls[0][0].messages[0].content as string;
    expect(userContent).toContain('## Relevant known facts');
    expect(userContent).toContain('Aaron Nichols');
  });

  it('omits the RAG block when search returns no facts', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ status: 'noop' }) });
    const store = makeStore({});
    const rag = makeRagStore(() => []);
    await resolveReferences(
      'assign the open PRs to aaron',
      store,
      makeConfig(),
      undefined,
      undefined,
      rag,
    );
    const userContent = generateTextMock.mock.calls[0][0].messages[0].content as string;
    expect(userContent).not.toContain('## Relevant known facts');
  });

  it('omits the RAG block when ragStore is undefined (existing behavior)', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ status: 'noop' }) });
    const store = makeStore({ 'daughter-allyson': 'Allyson' });
    await resolveReferences('order my daughter sandwich', store, makeConfig());
    const userContent = generateTextMock.mock.calls[0][0].messages[0].content as string;
    expect(userContent).not.toContain('## Relevant known facts');
  });

  it('fails open to noop when ragStore.search throws', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ status: 'noop' }) });
    const store = makeStore({});
    const rag = {
      search: vi.fn(async () => {
        throw new Error('embedding backend down');
      }),
    } as unknown as RAGStore;
    const result = await resolveReferences(
      'assign the open PRs to aaron',
      store,
      makeConfig(),
      undefined,
      undefined,
      rag,
    );
    expect(result).toEqual({ status: 'noop' });
    // generateText should still be called (resolver degrades to memory-only path)
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const userContent = generateTextMock.mock.calls[0][0].messages[0].content as string;
    expect(userContent).not.toContain('## Relevant known facts');
  });

  it('prefers a memory-sourced entry when both memory and RAG match', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        status: 'resolved',
        entries: [
          {
            phrase: 'aaron',
            resolvedTo: 'Aaron Nichols',
            sourceKey: 'aaron-nichols',
          },
        ],
      }),
    });
    const store = makeStore({ 'aaron-nichols': 'Aaron Nichols, engineer' });
    const rag = makeRagStore(() => [
      { fact: 'Aaron Nichols is an engineer.', similarity: 0.72, domain: 'people' },
    ]);
    const result = await resolveReferences(
      'assign the open PRs to aaron',
      store,
      makeConfig(),
      undefined,
      undefined,
      rag,
    );
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.entries[0].sourceKey).toBe('aaron-nichols');
    }
  });
});

describe('validateAgainstMemory', () => {
  it('keeps entries whose sourceKey is in memory', () => {
    const result = validateAgainstMemory(
      {
        status: 'resolved',
        entries: [{ phrase: 'x', resolvedTo: 'y', sourceKey: 'known-key' }],
      },
      new Set(['known-key']),
    );
    expect(result.status).toBe('resolved');
  });

  it('keeps entries with sourceKey "rag" when RAG facts were provided', () => {
    const result = validateAgainstMemory(
      {
        status: 'resolved',
        entries: [{ phrase: 'aaron', resolvedTo: 'Aaron Nichols', sourceKey: RAG_SOURCE_KEY }],
      },
      new Set(),
      true,
    );
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.entries[0].sourceKey).toBe('rag');
    }
  });

  it('drops entries with sourceKey "rag" when no RAG facts were injected', () => {
    const result = validateAgainstMemory(
      {
        status: 'resolved',
        entries: [{ phrase: 'aaron', resolvedTo: 'Aaron Nichols', sourceKey: RAG_SOURCE_KEY }],
      },
      new Set(),
      false,
    );
    expect(result).toEqual({ status: 'noop' });
  });

  it('drops entries with unknown sourceKey', () => {
    const result = validateAgainstMemory(
      {
        status: 'resolved',
        entries: [{ phrase: 'x', resolvedTo: 'y', sourceKey: 'made-up' }],
      },
      new Set(['real-key']),
    );
    expect(result).toEqual({ status: 'noop' });
  });
});

describe('buildRecentTurnsBlock', () => {
  it('returns empty string for empty history', () => {
    expect(buildRecentTurnsBlock([])).toBe('');
  });

  it('extracts string content from user turns', () => {
    const history: CoreMessage[] = [{ role: 'user', content: 'aaron is my PhoneBurner teammate' }];
    const block = buildRecentTurnsBlock(history);
    expect(block).toContain('## Recent conversation');
    expect(block).toContain('user: aaron is my PhoneBurner teammate');
  });

  it('extracts text parts from assistant turns', () => {
    const history: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text' as const, text: 'Got it — Aaron is noted.' },
          { type: 'tool-call' as const, toolCallId: '1', toolName: 'memory', args: {} },
        ] as any,
      },
    ];
    const block = buildRecentTurnsBlock(history);
    expect(block).toContain('assistant: Got it — Aaron is noted.');
  });

  it('caps at most N recent turns (oldest dropped)', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'turn 2' },
      { role: 'user', content: 'turn 3' },
      { role: 'assistant', content: 'turn 4' },
      { role: 'user', content: 'turn 5' },
      { role: 'assistant', content: 'turn 6' },
    ];
    const block = buildRecentTurnsBlock(history);
    expect(block).not.toContain('turn 1');
    expect(block).not.toContain('turn 2');
    expect(block).toContain('turn 6');
  });

  it('truncates very long turns with ellipsis', () => {
    const longText = 'x'.repeat(1000);
    const history: CoreMessage[] = [{ role: 'user', content: longText }];
    const block = buildRecentTurnsBlock(history);
    expect(block).toContain('…');
    expect(block.length).toBeLessThan(longText.length);
  });

  it('skips messages with empty text (e.g. tool-only assistant turns)', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call' as const, toolCallId: '1', toolName: 'x', args: {} }] as any,
      },
    ];
    const block = buildRecentTurnsBlock(history);
    expect(block).toContain('user: hello');
    expect(block).not.toContain('assistant:');
  });

  it('ignores non-user/non-assistant messages', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: '1', toolName: 'x', result: {} }] as any,
      },
    ];
    const block = buildRecentTurnsBlock(history);
    expect(block).toContain('user: hi');
    expect(block).not.toContain('tool:');
  });
});

describe('resolveReferences with history', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('injects the recent-conversation block into the user message', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ status: 'noop' }) });
    const store = makeStore({});
    const history: CoreMessage[] = [
      { role: 'user', content: 'aaron is my PhoneBurner teammate' },
      { role: 'assistant', content: 'Understood. I will remember that.' },
    ];
    await resolveReferences(
      'assign the open PRs to aaron',
      store,
      makeConfig(),
      undefined,
      undefined,
      undefined,
      history,
    );
    const userContent = generateTextMock.mock.calls[0][0].messages[0].content as string;
    expect(userContent).toContain('## Recent conversation');
    expect(userContent).toContain('aaron is my PhoneBurner teammate');
  });

  it('omits the recent-conversation block when history is empty', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ status: 'noop' }) });
    const store = makeStore({});
    await resolveReferences(
      'assign the open PRs to aaron',
      store,
      makeConfig(),
      undefined,
      undefined,
      undefined,
      [],
    );
    const userContent = generateTextMock.mock.calls[0][0].messages[0].content as string;
    expect(userContent).not.toContain('## Recent conversation');
  });

  it('omits the recent-conversation block when history arg is undefined', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ status: 'noop' }) });
    const store = makeStore({});
    await resolveReferences('assign the open PRs to aaron', store, makeConfig());
    const userContent = generateTextMock.mock.calls[0][0].messages[0].content as string;
    expect(userContent).not.toContain('## Recent conversation');
  });
});

describe('renderResolvedBlock (RAG label)', () => {
  it('renders (from knowledge base) for rag-sourced entries', () => {
    const entries: ResolvedEntry[] = [
      { phrase: 'aaron', resolvedTo: 'Aaron Nichols', sourceKey: RAG_SOURCE_KEY },
    ];
    const block = renderResolvedBlock(entries);
    expect(block).toContain('"aaron" → Aaron Nichols');
    expect(block).toContain('(from knowledge base)');
    expect(block).not.toContain('(from memory: rag)');
  });

  it('renders (from memory: <key>) for memory-sourced entries', () => {
    const entries: ResolvedEntry[] = [
      { phrase: 'my daughter', resolvedTo: 'Allyson', sourceKey: 'daughter-allyson' },
    ];
    const block = renderResolvedBlock(entries);
    expect(block).toContain('(from memory: daughter-allyson)');
  });
});

describe('stripToolResolvableTokens', () => {
  it('strips https and http URLs', () => {
    expect(stripToolResolvableTokens('review https://github.com/foo/bar/pull/3')).toBe('review');
    expect(stripToolResolvableTokens('see http://example.com/x')).toBe('see');
  });

  it('strips "PR 3802", "issue 45", and "#123" references', () => {
    expect(stripToolResolvableTokens('look at PR 3802 please')).toBe('look at please');
    expect(stripToolResolvableTokens('check issue 45')).toBe('check');
    expect(stripToolResolvableTokens('fix #123 today')).toBe('fix today');
    expect(stripToolResolvableTokens('close pull 99')).toBe('close');
  });

  it('strips absolute and home-relative file paths', () => {
    expect(stripToolResolvableTokens('summarize /home/me/notes.md')).toBe('summarize');
    expect(stripToolResolvableTokens('open ~/.config/app.json')).toBe('open');
    expect(stripToolResolvableTokens('read ./src/foo.ts for context')).toBe('read for context');
  });

  it('strips commit hashes (7–40 hex chars)', () => {
    expect(stripToolResolvableTokens('revert abcdef1 for me')).toBe('revert for me');
    expect(stripToolResolvableTokens('diff 0123456789abcdef')).toBe('diff');
    // 6-char hex is below the threshold and must not be stripped.
    expect(stripToolResolvableTokens('commit abc123')).toBe('commit abc123');
  });

  it('leaves bare names, word-pairs, and hostnames alone', () => {
    expect(stripToolResolvableTokens('tell me about aaron')).toBe('tell me about aaron');
    expect(stripToolResolvableTokens('does foo.bar work')).toBe('does foo.bar work');
    expect(stripToolResolvableTokens("aaron's PR needs review")).toBe("aaron's PR needs review");
  });

  it('returns empty string for URL-only input', () => {
    expect(stripToolResolvableTokens('https://github.com/foo/bar')).toBe('');
    expect(stripToolResolvableTokens('  /home/me/x.md  ')).toBe('');
  });
});

describe('resolveReferences short-circuits tool-resolvable input', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('does not call generateText when the reference phrase is entirely a URL', async () => {
    // The REPL layer pipes input through stripToolResolvableTokens, but the resolver itself
    // also benefits: a prompt with no possessive/demonstrative tokens after stripping
    // should skip. Here we verify the existing skip path still fires — `https://...` alone
    // has no reference signal, so shouldSkipResolver returns true and generateText is never
    // called.
    const store = makeStore({});
    const result = await resolveReferences(
      'https://github.com/foo/bar/pull/3',
      store,
      makeConfig(),
    );
    expect(result).toEqual({ status: 'noop' });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('still calls generateText for a bare-name reference with no tool-resolvable tokens', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ status: 'unknown', reference: 'my brother' }),
    });
    const store = makeStore({});
    await resolveReferences('did my brother email me', store, makeConfig());
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});
