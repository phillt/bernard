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
  type ResolvedEntry,
} from './reference-resolver.js';
import { MemoryStore } from './memory.js';
import type { BernardConfig } from './config.js';

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
