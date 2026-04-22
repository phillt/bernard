import { describe, it, expect } from 'vitest';
import { getModelProfile } from './profiles.js';

describe('getModelProfile — resolution', () => {
  it('returns anthropic-claude for any anthropic model', () => {
    expect(getModelProfile('anthropic', 'claude-sonnet-4-5-20250929').family).toBe(
      'anthropic-claude',
    );
    expect(getModelProfile('anthropic', 'claude-opus-4-6').family).toBe('anthropic-claude');
    expect(getModelProfile('anthropic', 'claude-haiku-4-5-20251001').family).toBe(
      'anthropic-claude',
    );
    expect(getModelProfile('anthropic', 'some-future-model').family).toBe('anthropic-claude');
  });

  it('routes OpenAI o-series models to openai-reasoning', () => {
    expect(getModelProfile('openai', 'o1').family).toBe('openai-reasoning');
    expect(getModelProfile('openai', 'o3').family).toBe('openai-reasoning');
    expect(getModelProfile('openai', 'o3-mini').family).toBe('openai-reasoning');
    expect(getModelProfile('openai', 'o4-mini').family).toBe('openai-reasoning');
  });

  it('routes non-o-series OpenAI models to openai-standard', () => {
    expect(getModelProfile('openai', 'gpt-4o').family).toBe('openai-standard');
    expect(getModelProfile('openai', 'gpt-4o-mini').family).toBe('openai-standard');
    expect(getModelProfile('openai', 'gpt-4.1').family).toBe('openai-standard');
    expect(getModelProfile('openai', 'gpt-4.1-nano').family).toBe('openai-standard');
    expect(getModelProfile('openai', 'gpt-5.2').family).toBe('openai-standard');
    expect(getModelProfile('openai', 'gpt-5.2-chat-latest').family).toBe('openai-standard');
  });

  it('routes xai grok-4 reasoning variants to xai-grok-reasoning', () => {
    expect(getModelProfile('xai', 'grok-4-fast-reasoning').family).toBe('xai-grok-reasoning');
    expect(getModelProfile('xai', 'grok-4-1-fast-reasoning').family).toBe('xai-grok-reasoning');
    expect(getModelProfile('xai', 'grok-4-0709').family).toBe('xai-grok-reasoning');
  });

  it('routes xai explicit non-reasoning variants to xai-grok-standard', () => {
    expect(getModelProfile('xai', 'grok-4-fast-non-reasoning').family).toBe('xai-grok-standard');
    expect(getModelProfile('xai', 'grok-4-1-fast-non-reasoning').family).toBe('xai-grok-standard');
  });

  it('routes older xai grok-3 and grok-code to xai-grok-standard', () => {
    expect(getModelProfile('xai', 'grok-3').family).toBe('xai-grok-standard');
    expect(getModelProfile('xai', 'grok-3-mini').family).toBe('xai-grok-standard');
    expect(getModelProfile('xai', 'grok-code-fast-1').family).toBe('xai-grok-standard');
  });

  it('falls back to default for unknown providers', () => {
    expect(getModelProfile('cohere', 'command-r').family).toBe('default');
    expect(getModelProfile('', '').family).toBe('default');
  });

  it('is case-insensitive on model names', () => {
    expect(getModelProfile('openai', 'O3').family).toBe('openai-reasoning');
    expect(getModelProfile('xai', 'Grok-4-Fast-Reasoning').family).toBe('xai-grok-reasoning');
  });
});

describe('wrapUserMessage — per family', () => {
  it('wraps Claude messages in <user_request>', () => {
    const out = getModelProfile('anthropic', 'claude-opus-4-6').wrapUserMessage('list files');
    expect(out).toBe('<user_request>\nlist files\n</user_request>');
  });

  it('wraps OpenAI standard messages with a markdown heading', () => {
    const out = getModelProfile('openai', 'gpt-4.1').wrapUserMessage('list files');
    expect(out).toBe('# Request\nlist files');
  });

  it('passes reasoning-model messages through unchanged', () => {
    expect(getModelProfile('openai', 'o3').wrapUserMessage('list files')).toBe('list files');
    expect(getModelProfile('xai', 'grok-4-fast-reasoning').wrapUserMessage('list files')).toBe(
      'list files',
    );
  });

  it('is lossless — original message appears verbatim in the wrap', () => {
    const tricky = 'Fix this: x < y && y > 0\n\nAlso: please keep changes minimal.';
    for (const [provider, model] of [
      ['anthropic', 'claude-opus-4-6'],
      ['openai', 'gpt-5.2'],
      ['openai', 'o3'],
      ['xai', 'grok-4-fast-reasoning'],
      ['xai', 'grok-3'],
    ] as const) {
      const out = getModelProfile(provider, model).wrapUserMessage(tricky);
      expect(out).toContain(tricky);
    }
  });
});

describe('systemSuffix — per family', () => {
  it('includes XML-wrapping note for Claude', () => {
    expect(getModelProfile('anthropic', 'claude-opus-4-6').systemSuffix).toContain(
      '<user_request>',
    );
  });

  it('includes Formatting re-enabled for OpenAI reasoning models', () => {
    expect(getModelProfile('openai', 'o3').systemSuffix).toMatch(/^Formatting re-enabled/);
  });

  it('includes agentic persistence guidance for OpenAI standard models', () => {
    expect(getModelProfile('openai', 'gpt-4.1').systemSuffix).toMatch(/Persistence/i);
  });

  it('strips CoT language for all reasoning families', () => {
    expect(getModelProfile('openai', 'o3').systemSuffix).toMatch(/chain-of-thought/i);
    expect(getModelProfile('xai', 'grok-4-fast-reasoning').systemSuffix).toMatch(
      /chain-of-thought/i,
    );
  });

  it('leaves non-reasoning xai standard models with no suffix', () => {
    expect(getModelProfile('xai', 'grok-3').systemSuffix).toBe('');
  });

  it('default profile has no suffix and passthrough wrap', () => {
    const p = getModelProfile('unknown', 'mystery-model');
    expect(p.systemSuffix).toBe('');
    expect(p.wrapUserMessage('hi')).toBe('hi');
  });
});

describe('rewriterHint — per family', () => {
  it('every family has a non-empty rewriterHint', () => {
    for (const [provider, model] of [
      ['anthropic', 'claude-opus-4-6'],
      ['openai', 'o3'],
      ['openai', 'gpt-4.1'],
      ['xai', 'grok-4-fast-reasoning'],
      ['xai', 'grok-3'],
      ['unknown', 'mystery-model'],
    ] as const) {
      const hint = getModelProfile(provider, model).rewriterHint;
      expect(hint.length).toBeGreaterThan(0);
    }
  });

  it('reasoning-family hints emphasize terseness', () => {
    expect(getModelProfile('openai', 'o3').rewriterHint).toMatch(/terse/i);
    expect(getModelProfile('xai', 'grok-4-fast-reasoning').rewriterHint).toMatch(/terse|direct/i);
  });
});
