import { describe, it, expect, vi } from 'vitest';
import {
  checkProviderKey,
  keyCheckEndpoint,
  tidyKey,
  type CheckVerdict,
} from './provider-key-check.js';

const KEY = 'sk-ant-secret-value-0001';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** A fetch that records every request and answers from a status table. */
function fakeFetch(answer: (url: URL) => { status: number } | Promise<never>) {
  const calls: Call[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: url.toString(), method: init?.method ?? 'GET', headers });
    const res = await answer(url);
    return { status: res.status } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('checkProviderKey — the zero-credit case, which is the whole point', () => {
  it('calls the unbilled endpoint and never a billed one', async () => {
    // The account this is modelled on answers 200 on the model list and 400
    // "Your credit balance is too low" on a completion. `validateModel` reaches
    // for the completion and so reports a VALID key as a failure.
    const { impl, calls } = fakeFetch((url) =>
      url.pathname.endsWith('/models') ? { status: 200 } : { status: 400 },
    );
    const verdict = await checkProviderKey({ sdk: 'anthropic', key: KEY, fetchImpl: impl });

    expect(verdict.tone).toBe('ok');
    // The assertion that actually pins it. "200 → ok" alone would pass against
    // an implementation that had ALSO tried a completion first — which is
    // exactly the mistake this module exists to avoid.
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(calls.every((c) => c.url.endsWith('/models'))).toBe(true);
  });
});

describe('checkProviderKey — what each status means', () => {
  async function verdictFor(status: number): Promise<CheckVerdict> {
    const { impl } = fakeFetch(() => ({ status }));
    return checkProviderKey({ sdk: 'openai', key: KEY, fetchImpl: impl });
  }

  it.each([
    [200, 'ok'],
    [429, 'ok'],
    [401, 'bad'],
    [403, 'unknown'],
    [404, 'unknown'],
    [500, 'unknown'],
    [418, 'unknown'],
  ])('%i reads as %s', async (status, tone) => {
    expect((await verdictFor(status)).tone).toBe(tone);
  });

  it('does not call a key invalid just because it cannot list models', async () => {
    // 403 is the second half of the rule. Anthropic's `permission_error` and
    // OpenAI's scoped project keys both authenticate and then refuse this
    // endpoint — a valid key, one status code away from being called bad.
    const verdict = await verdictFor(403);
    expect(verdict.tone).not.toBe('bad');
    expect(verdict.message).toMatch(/works/);
  });

  it('says a throttled key is valid, and says it is throttled', async () => {
    // "Valid" alone, moments before a first call that may be refused, reads as
    // a promise the next screen breaks.
    const verdict = await verdictFor(429);
    expect(verdict.tone).toBe('ok');
    expect(verdict.message).toMatch(/rate limited/i);
  });

  it('never reports invalid when the network is the problem', async () => {
    const { impl } = fakeFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    const verdict = await checkProviderKey({ sdk: 'xai', key: KEY, fetchImpl: impl });
    expect(verdict.tone).toBe('unknown');
    expect(verdict.message).toMatch(/could not be reached/);
  });

  it('ends on its own when the endpoint never answers', async () => {
    // The overlay draws no spinner, so a hang and a freeze look identical
    // there; the only mitigation is that the wait always terminates.
    // Honours the signal the way real `fetch` does — a fake that ignored it
    // would hang here rather than prove the bound works.
    const impl = ((_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof fetch;
    const verdict = await checkProviderKey({
      sdk: 'openai',
      key: KEY,
      fetchImpl: impl,
      timeoutMs: 20,
    });
    expect(verdict.tone).toBe('unknown');
    expect(verdict.message).toMatch(/in time/);
  });
});

describe('checkProviderKey — auth shape per SDK', () => {
  async function headersFor(sdk: 'anthropic' | 'openai' | 'xai') {
    const { impl, calls } = fakeFetch(() => ({ status: 200 }));
    await checkProviderKey({ sdk, key: KEY, fetchImpl: impl });
    return calls[0].headers;
  }

  it('sends Anthropic its own header pair and no bearer token', async () => {
    const h = await headersFor('anthropic');
    expect(h['x-api-key']).toBe(KEY);
    expect(h['anthropic-version']).toBeDefined();
    expect(h['authorization']).toBeUndefined();
  });

  it.each([['openai'], ['xai']] as const)(
    'sends %s a bearer token and no x-api-key',
    async (sdk) => {
      const h = await headersFor(sdk);
      expect(h['authorization']).toBe(`Bearer ${KEY}`);
      expect(h['x-api-key']).toBeUndefined();
    },
  );

  it('keeps the key out of the verdict it hands back', async () => {
    // A 401 body is where a provider is likeliest to echo request material.
    const { impl } = fakeFetch(() => ({ status: 401 }));
    const verdict = await checkProviderKey({ sdk: 'anthropic', key: KEY, fetchImpl: impl });
    expect(JSON.stringify(verdict)).not.toContain(KEY);
  });
});

/**
 * Where the request goes — the test that catches sending a secret to the wrong
 * host, which is the one defect here that would matter beyond a wrong message.
 */
describe('keyCheckEndpoint', () => {
  it('uses the vendor default when nothing else names one', () => {
    expect(keyCheckEndpoint('anthropic').toString()).toBe('https://api.anthropic.com/v1/models');
    expect(keyCheckEndpoint('openai').toString()).toBe('https://api.openai.com/v1/models');
    expect(keyCheckEndpoint('xai').toString()).toBe('https://api.x.ai/v1/models');
  });

  it('goes to the caller’s own endpoint when there is one', () => {
    // A custom provider's key is minted for ITS gateway. Sending it to the
    // vendor because the SDK happens to be `anthropic` would be handing someone
    // else a secret.
    const url = keyCheckEndpoint('anthropic', 'http://localhost:11434/v1');
    expect(url.host).toBe('localhost:11434');
    expect(url.toString()).toBe('http://localhost:11434/v1/models');
  });

  it.each([['http://host/v1'], ['http://host/v1/']])(
    'joins %s without doubling the path',
    (base) => {
      // A base URL usually already ends in `/v1`; concatenation yields
      // `/v1/v1/models`, which 404s and would read as "your key is bad".
      expect(keyCheckEndpoint('openai', base).pathname).toBe('/v1/models');
    },
  );

  it('treats a blank base URL as absent rather than as a URL', () => {
    expect(keyCheckEndpoint('openai', '   ').host).toBe('api.openai.com');
  });
});

describe('tidyKey', () => {
  it.each([
    ['  sk-test  ', 'sk-test'],
    ['"sk-test"', 'sk-test'],
    ["'sk-test'", 'sk-test'],
    ['sk-test\n', 'sk-test'],
    ['"sk-test"\n', 'sk-test'],
  ])('%j becomes %j', (raw, want) => {
    // The likeliest false "invalid" in practice: a key pasted out of a JSON
    // blob, with the quotes and the clipboard's newline still attached.
    expect(tidyKey(raw)).toBe(want);
  });

  it('leaves a quote that is not a wrapper alone', () => {
    expect(tidyKey('sk-"weird"-key')).toBe('sk-"weird"-key');
  });

  it('checks nothing when there is nothing to check', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200 }));
    const verdict = await checkProviderKey({ sdk: 'openai', key: '  ', fetchImpl: impl });
    expect(verdict.tone).toBe('unknown');
    expect(calls).toEqual([]);
  });
});
