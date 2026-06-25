import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logCalls: { label: string; data: any }[] = [];
vi.mock('../../logger.js', async () => {
  const actual = await vi.importActual<typeof import('../../logger.js')>('../../logger.js');
  return {
    ...actual,
    isDebugEnabled: () => !!(globalThis as { __debugForFetchTest?: boolean }).__debugForFetchTest,
    debugLog: (label: string, data: unknown) => {
      logCalls.push({ label, data });
    },
  };
});

import {
  installInstrumentedFetchIfDebug,
  __resetInstrumentedFetchForTesting,
} from '../instrumented-fetch.js';
import { runWithDispatchId } from '../dispatch-context.js';

let originalFetch: typeof fetch;

beforeEach(() => {
  logCalls.length = 0;
  originalFetch = globalThis.fetch;
  (globalThis as { __debugForFetchTest?: boolean }).__debugForFetchTest = true;
});

afterEach(() => {
  __resetInstrumentedFetchForTesting(originalFetch);
  (globalThis as { __debugForFetchTest?: boolean }).__debugForFetchTest = false;
});

function fakeOk(body = 'hello world', delayMs = 0): typeof fetch {
  return (async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  }) as unknown as typeof fetch;
}

describe('installInstrumentedFetchIfDebug', () => {
  it('is a no-op when debug is off', () => {
    (globalThis as { __debugForFetchTest?: boolean }).__debugForFetchTest = false;
    const before = globalThis.fetch;
    installInstrumentedFetchIfDebug();
    expect(globalThis.fetch).toBe(before);
  });

  it('emits start, headers, and end events with monotonic ttlms', async () => {
    globalThis.fetch = fakeOk('payload payload payload', 5);
    installInstrumentedFetchIfDebug();
    const res = await globalThis.fetch('https://api.example.com/v1/messages?token=secret', {
      method: 'POST',
    });
    const text = await res.text();
    expect(text).toBe('payload payload payload');

    const labels = logCalls.map((c) => c.label);
    expect(labels).toContain('http:request:start');
    expect(labels).toContain('http:response:headers');
    expect(labels).toContain('http:response:end');

    const start = logCalls.find((c) => c.label === 'http:request:start')!;
    const headers = logCalls.find((c) => c.label === 'http:response:headers')!;
    const end = logCalls.find((c) => c.label === 'http:response:end')!;
    expect(start.data.host).toBe('api.example.com');
    expect(start.data.path).toBe('/v1/messages');
    expect(start.data.method).toBe('POST');
    expect(headers.data.status).toBe(200);
    expect(typeof headers.data.ttlms).toBe('number');
    expect(end.data.bytes).toBe('payload payload payload'.length);
    expect(end.data.ttlmsTotal).toBeGreaterThanOrEqual(headers.data.ttlms);
  });

  it('never logs query strings, request bodies, or headers', async () => {
    globalThis.fetch = fakeOk();
    installInstrumentedFetchIfDebug();
    await globalThis.fetch('https://api.example.com/x?api_key=sekrit&q=cats', {
      method: 'POST',
      headers: { authorization: 'Bearer SECRET' },
      body: 'private prompt content',
    });
    const all = JSON.stringify(logCalls);
    expect(all).not.toContain('sekrit');
    expect(all).not.toContain('cats');
    expect(all).not.toContain('SECRET');
    expect(all).not.toContain('private prompt content');
    expect(all).not.toMatch(/\?api_key/);
    for (const c of logCalls) {
      expect(c.data).not.toHaveProperty('url');
      expect(c.data).not.toHaveProperty('headers');
      expect(c.data).not.toHaveProperty('body');
      expect(c.data).not.toHaveProperty('query');
    }
  });

  it('logs http:request:error when fetch rejects', async () => {
    globalThis.fetch = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    installInstrumentedFetchIfDebug();
    await expect(globalThis.fetch('https://api.example.com/')).rejects.toThrow('boom');
    const err = logCalls.find((c) => c.label === 'http:request:error');
    expect(err).toBeDefined();
    expect(err!.data.message).toBe('boom');
  });

  it('correlates http events with the active dispatchId', async () => {
    globalThis.fetch = fakeOk();
    installInstrumentedFetchIfDebug();
    await runWithDispatchId('abc12345', async () => {
      const res = await globalThis.fetch('https://api.example.com/v1/messages');
      await res.text();
    });
    const start = logCalls.find((c) => c.label === 'http:request:start')!;
    const end = logCalls.find((c) => c.label === 'http:response:end')!;
    expect(start.data.dispatchId).toBe('abc12345');
    expect(end.data.dispatchId).toBe('abc12345');
  });

  it('omits dispatchId when no dispatch is active', async () => {
    globalThis.fetch = fakeOk();
    installInstrumentedFetchIfDebug();
    const res = await globalThis.fetch('https://api.example.com/');
    await res.text();
    const start = logCalls.find((c) => c.label === 'http:request:start')!;
    expect(start.data.dispatchId).toBeUndefined();
  });
});
