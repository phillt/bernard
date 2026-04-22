import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./providers/index.js', () => ({
  getModel: vi.fn(() => ({ modelId: 'mock' })),
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

import { rewritePrompt, shouldSkipRewriter, skipRewriterReason } from './prompt-rewriter.js';
import type { ModelProfile } from './providers/profiles.js';
import type { ResolvedEntry } from './reference-resolver.js';
import type { BernardConfig } from './config.js';

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    family: 'test-family',
    wrapUserMessage: (m) => m,
    systemSuffix: '',
    rewriterHint: 'be terse and structured',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<BernardConfig> = {}): BernardConfig {
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
    promptRewriter: true,
    ...overrides,
  };
}

const LONG_INPUT =
  'Can you look at the failing test in src/foo.ts and figure out whether the assertion or the implementation is wrong, then fix whichever is at fault?';

describe('shouldSkipRewriter', () => {
  it('skips very short input', () => {
    expect(shouldSkipRewriter('hi')).toBe(true);
    expect(shouldSkipRewriter('yes')).toBe(true);
  });

  it('skips slash commands', () => {
    expect(shouldSkipRewriter('/options')).toBe(true);
    expect(shouldSkipRewriter('/provider openai')).toBe(true);
  });

  it('skips input that already starts with a structural marker', () => {
    expect(shouldSkipRewriter('Task: do the thing')).toBe(true);
    expect(shouldSkipRewriter('# Request\nfoo')).toBe(true);
    expect(shouldSkipRewriter('<user_request>foo</user_request>')).toBe(true);
  });

  it('does not skip normal prose prompts', () => {
    expect(shouldSkipRewriter(LONG_INPUT)).toBe(false);
    expect(shouldSkipRewriter('what is going on with the build')).toBe(false);
  });
});

describe('shouldSkipRewriter — conversational heuristics', () => {
  it('skips bare acknowledgments', () => {
    expect(skipRewriterReason('thanks!')).toBe('conversational');
    expect(skipRewriterReason('got it')).toBe('conversational');
    expect(skipRewriterReason('sounds good')).toBe('conversational');
    expect(skipRewriterReason('continue')).toBe('conversational');
  });

  it('skips single-word conversational questions', () => {
    expect(skipRewriterReason('really?')).toBe('conversational');
    expect(skipRewriterReason('why?')).toBe('conversational');
    expect(skipRewriterReason('how come?')).toBe('conversational');
  });

  it('skips followup prefixes that key off conversation state', () => {
    expect(skipRewriterReason('what about the other one?')).toBe('followup');
    expect(skipRewriterReason('how about tomorrow?')).toBe('followup');
    expect(skipRewriterReason('why not keep the old one')).toBe('followup');
    expect(skipRewriterReason('can you also add tests')).toBe('followup');
  });

  it('does NOT skip a substantive request that happens to start with "ok"', () => {
    expect(skipRewriterReason('ok so rewrite this function to handle nulls')).toBeNull();
    expect(skipRewriterReason('okay, next please look at src/foo.ts and fix it')).toBeNull();
  });

  it('does NOT skip long prose even if it contains conversational words', () => {
    expect(skipRewriterReason(LONG_INPUT)).toBeNull();
  });
});

describe('rewritePrompt — disabled config', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('returns noop and does not call generateText when promptRewriter is false', async () => {
    const result = await rewritePrompt(
      LONG_INPUT,
      makeProfile(),
      [],
      makeConfig({ promptRewriter: false }),
    );
    expect(result).toEqual({ status: 'noop' });
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe('rewritePrompt — skip conditions', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('skips short input', async () => {
    const result = await rewritePrompt('hi', makeProfile(), [], makeConfig());
    expect(result).toEqual({ status: 'noop' });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('skips slash commands', async () => {
    const result = await rewritePrompt('/provider', makeProfile(), [], makeConfig());
    expect(result).toEqual({ status: 'noop' });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('skips already-structured input', async () => {
    const result = await rewritePrompt('Task: deploy foo', makeProfile(), [], makeConfig());
    expect(result).toEqual({ status: 'noop' });
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe('rewritePrompt — happy path', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('returns rewritten text when the model emits a valid response', async () => {
    generateTextMock.mockResolvedValue({
      text: '{"status":"rewritten","text":"Task: inspect src/foo.ts failing test and fix the root cause, whether in the assertion or the implementation."}',
    });

    const result = await rewritePrompt(LONG_INPUT, makeProfile(), [], makeConfig());

    expect(result.status).toBe('rewritten');
    if (result.status === 'rewritten') {
      expect(result.text).toContain('src/foo.ts');
    }
  });

  it('injects the per-family rewriterHint into the system prompt', async () => {
    generateTextMock.mockResolvedValue({ text: '{"status":"noop"}' });

    await rewritePrompt(
      LONG_INPUT,
      makeProfile({ family: 'anthropic-claude', rewriterHint: 'UNIQUE_HINT_MARKER' }),
      [],
      makeConfig(),
    );

    const system = generateTextMock.mock.calls[0][0].system as string;
    expect(system).toContain('UNIQUE_HINT_MARKER');
    expect(system).toContain('anthropic-claude');
  });

  it('includes resolved entries in the user message for optional inlining', async () => {
    generateTextMock.mockResolvedValue({ text: '{"status":"noop"}' });
    const resolved: ResolvedEntry[] = [
      { phrase: 'my daughter', resolvedTo: 'Sarah, age 8', sourceKey: 'daughter' },
    ];

    await rewritePrompt(LONG_INPUT, makeProfile(), resolved, makeConfig());

    const userMsg = generateTextMock.mock.calls[0][0].messages[0].content as string;
    expect(userMsg).toContain('my daughter');
    expect(userMsg).toContain('Sarah, age 8');
  });

  it('omits the resolved-entities block when no entries are provided', async () => {
    generateTextMock.mockResolvedValue({ text: '{"status":"noop"}' });

    await rewritePrompt(LONG_INPUT, makeProfile(), [], makeConfig());

    const userMsg = generateTextMock.mock.calls[0][0].messages[0].content as string;
    expect(userMsg).not.toContain('Resolved entities');
  });

  it('calls generateText with temperature 0 for determinism', async () => {
    generateTextMock.mockResolvedValue({ text: '{"status":"noop"}' });

    await rewritePrompt(LONG_INPUT, makeProfile(), [], makeConfig());

    expect(generateTextMock.mock.calls[0][0].temperature).toBe(0);
  });
});

describe('rewritePrompt — fail-open paths', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('returns noop when generateText throws', async () => {
    generateTextMock.mockRejectedValue(new Error('network down'));

    const result = await rewritePrompt(LONG_INPUT, makeProfile(), [], makeConfig());

    expect(result).toEqual({ status: 'noop' });
  });

  it('returns noop when response is malformed JSON', async () => {
    generateTextMock.mockResolvedValue({ text: 'not json at all' });

    const result = await rewritePrompt(LONG_INPUT, makeProfile(), [], makeConfig());

    expect(result).toEqual({ status: 'noop' });
  });

  it('returns noop when response is valid JSON but unexpected shape', async () => {
    generateTextMock.mockResolvedValue({ text: '{"status":"something-else","foo":42}' });

    const result = await rewritePrompt(LONG_INPUT, makeProfile(), [], makeConfig());

    expect(result).toEqual({ status: 'noop' });
  });

  it('returns noop when rewritten text is empty', async () => {
    generateTextMock.mockResolvedValue({ text: '{"status":"rewritten","text":""}' });

    const result = await rewritePrompt(LONG_INPUT, makeProfile(), [], makeConfig());

    expect(result).toEqual({ status: 'noop' });
  });

  it('returns noop when rewritten text is suspiciously short vs original', async () => {
    generateTextMock.mockResolvedValue({
      text: '{"status":"rewritten","text":"foo"}',
    });

    const result = await rewritePrompt(LONG_INPUT, makeProfile(), [], makeConfig());

    expect(result).toEqual({ status: 'noop' });
  });

  it('returns noop when the model emits no text at all', async () => {
    generateTextMock.mockResolvedValue({ text: '' });

    const result = await rewritePrompt(LONG_INPUT, makeProfile(), [], makeConfig());

    expect(result).toEqual({ status: 'noop' });
  });

  it('passes the abortSignal through to generateText', async () => {
    generateTextMock.mockResolvedValue({ text: '{"status":"noop"}' });
    const ctrl = new AbortController();

    await rewritePrompt(LONG_INPUT, makeProfile(), [], makeConfig(), ctrl.signal);

    expect(generateTextMock.mock.calls[0][0].abortSignal).toBe(ctrl.signal);
  });
});
