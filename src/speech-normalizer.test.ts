import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
  traceLlm: <T>(_site: string, _model: string, fn: () => Promise<T>) => fn(),
}));

const resolveSiteModelMock = vi.fn();
vi.mock('./model-policy.js', async () => {
  const actual = await vi.importActual<typeof import('./model-policy.js')>('./model-policy.js');
  return { ...actual, resolveSiteModel: (...args: unknown[]) => resolveSiteModelMock(...args) };
});

const generateTextMock = vi.fn();
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, generateText: (...args: unknown[]) => generateTextMock(...args) };
});

import { normalizeSpeech, toSpokenForm } from './speech-normalizer.js';
import { toSpeechText } from './speech-text.js';
import { clearLLMCache } from './llm-cache.js';
import type { BernardConfig } from './config.js';

function makeConfig(overrides: Partial<BernardConfig> = {}): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-test',
    maxTokens: 4096,
    voiceNormalizer: true,
    cacheEnabled: false,
    ...overrides,
  } as BernardConfig;
}

/**
 * Long enough to clear `MIN_NORMALIZE_CHARS` and carrying an unresolved class,
 * so the skip predicate lets it through to the model.
 */
const WRITTEN =
  'The catalog now lists 1200 models across every provider, see https://example.com/models for the full list.';

function reply(text: string) {
  return {
    text,
    usage: { promptTokens: 10, completionTokens: 5 },
    providerMetadata: undefined,
  };
}

beforeEach(() => {
  generateTextMock.mockReset();
  resolveSiteModelMock.mockReset();
  resolveSiteModelMock.mockReturnValue({
    model: { modelId: 'mock-model' },
    providerOptions: undefined,
    params: {},
    provider: 'anthropic',
    modelName: 'claude-test',
    tier: 'cheap',
  });
  clearLLMCache();
});

describe('normalizeSpeech — when it declines to call the model', () => {
  it('is a noop when the pass is disabled, and makes no call', async () => {
    const res = await normalizeSpeech(
      toSpeechText(WRITTEN),
      makeConfig({ voiceNormalizer: false }),
    );
    expect(res).toEqual({ status: 'noop' });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('is a noop when stage 1 left nothing ambiguous', async () => {
    const plain = toSpeechText('Done. The tests pass and the build is clean, which is good news.');
    expect(plain.unresolved).toEqual([]);
    expect(await normalizeSpeech(plain, makeConfig())).toEqual({ status: 'noop' });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('is a noop when the reply is too short to be worth a round trip', async () => {
    expect(await normalizeSpeech(toSpeechText('See 2024.'), makeConfig())).toEqual({
      status: 'noop',
    });
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe('normalizeSpeech — output guards', () => {
  it('accepts a well-formed spoken script', async () => {
    const spoken =
      'The catalog now lists twelve hundred models across every provider. The full list is on example dot com.';
    generateTextMock.mockResolvedValue(reply(spoken));
    const res = await normalizeSpeech(toSpeechText(WRITTEN), makeConfig());
    expect(res).toEqual({ status: 'normalized', spokenForm: spoken });
  });

  it('strips a narrating preamble rather than rejecting the body', async () => {
    const body =
      'The catalog now lists twelve hundred models across every provider, on example dot com.';
    generateTextMock.mockResolvedValue(reply(`Sure, here it is:\n${body}`));
    const res = await normalizeSpeech(toSpeechText(WRITTEN), makeConfig());
    expect(res).toEqual({ status: 'normalized', spokenForm: body });
  });

  it.each([
    ['a code fence', '```\nnpm run build\n```'],
    ['a heading', '# Catalog\nTwelve hundred models are listed.'],
    ['a table row', '| Provider | Models |\n| anthropic | 12 |'],
  ])('rejects output that leaked %s', async (_label, out) => {
    generateTextMock.mockResolvedValue(reply(out));
    expect(await normalizeSpeech(toSpeechText(WRITTEN), makeConfig())).toEqual({ status: 'noop' });
  });

  it('rejects output that elaborates far past its input', async () => {
    generateTextMock.mockResolvedValue(reply('word '.repeat(500)));
    expect(await normalizeSpeech(toSpeechText(WRITTEN), makeConfig())).toEqual({ status: 'noop' });
  });

  it('rejects output that summarized instead of re-voicing', async () => {
    // The guard that mechanically enforces "re-translate, don't summarize".
    generateTextMock.mockResolvedValue(reply('Twelve hundred models.'));
    expect(await normalizeSpeech(toSpeechText(WRITTEN), makeConfig())).toEqual({ status: 'noop' });
  });

  it('is a noop on an empty response', async () => {
    generateTextMock.mockResolvedValue(reply(''));
    expect(await normalizeSpeech(toSpeechText(WRITTEN), makeConfig())).toEqual({ status: 'noop' });
  });
});

describe('normalizeSpeech — failure and cancellation', () => {
  it('is a noop when generateText throws, and lets nothing escape', async () => {
    generateTextMock.mockRejectedValue(new Error('provider exploded'));
    await expect(normalizeSpeech(toSpeechText(WRITTEN), makeConfig())).resolves.toEqual({
      status: 'noop',
    });
  });

  it('is a noop when the cheap tier has no resolvable model', async () => {
    resolveSiteModelMock.mockImplementation(() => {
      throw new Error('no API key for tier');
    });
    await expect(normalizeSpeech(toSpeechText(WRITTEN), makeConfig())).resolves.toEqual({
      status: 'noop',
    });
  });

  it('honours a pre-aborted signal on a cache hit, so a superseded readback cannot sneak through', async () => {
    const spoken =
      'The catalog now lists twelve hundred models across every provider, on example dot com.';
    generateTextMock.mockResolvedValue(reply(spoken));
    const config = makeConfig({ cacheEnabled: true });
    // Warm the cache with a real call…
    expect(await normalizeSpeech(toSpeechText(WRITTEN), config)).toEqual({
      status: 'normalized',
      spokenForm: spoken,
    });
    // …then the cheap path must still respect the signal.
    const res = await normalizeSpeech(toSpeechText(WRITTEN), config, AbortSignal.abort());
    expect(res).toEqual({ status: 'noop' });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});

describe('normalizeSpeech — usage', () => {
  it('records usage once on a real call and not at all on a cache hit', async () => {
    const spoken =
      'The catalog now lists twelve hundred models across every provider, on example dot com.';
    generateTextMock.mockResolvedValue(reply(spoken));
    const onUsage = vi.fn();
    const config = makeConfig({ cacheEnabled: true });

    await normalizeSpeech(toSpeechText(WRITTEN), config, undefined, onUsage);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0]).toMatchObject({ site: 'speech-normalizer', bucket: 'cheap' });

    await normalizeSpeech(toSpeechText(WRITTEN), config, undefined, onUsage);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});

describe('toSpokenForm — the fail-open chain', () => {
  it('returns the model text when the pass succeeds', async () => {
    const spoken =
      'The catalog now lists twelve hundred models across every provider, on example dot com.';
    generateTextMock.mockResolvedValue(reply(spoken));
    expect(await toSpokenForm(WRITTEN, makeConfig())).toEqual({
      text: spoken,
      normalized: true,
    });
  });

  it('falls open to the deterministic reduction — never to raw markdown', async () => {
    generateTextMock.mockRejectedValue(new Error('down'));
    const res = await toSpokenForm(`## Heading\n\n${WRITTEN}`, makeConfig());
    expect(res.normalized).toBe(false);
    expect(res.text).not.toContain('##');
    expect(res.text).not.toContain('https://');
    expect(res.text).toContain('example dot com');
  });

  it('still strips markup when the pass is disabled', async () => {
    // The deterministic layer is unconditional; only the LLM half is opt-out.
    const res = await toSpokenForm(
      '## Results\n\n- **all** green\n\n```sh\nnpm test\n```',
      makeConfig({ voiceNormalizer: false }),
    );
    expect(res.normalized).toBe(false);
    expect(res.text).toBe('Results. all green. A sh code block, omitted.');
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('flattens to a single argv-safe line', async () => {
    const res = await toSpokenForm('# A\n\n- one\n- two', makeConfig());
    expect(res.text).not.toContain('\n');
  });

  it('returns empty for input with nothing to say', async () => {
    expect((await toSpokenForm('   \n\n', makeConfig())).text).toBe('');
  });
});
