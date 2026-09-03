import { describe, it, expect } from 'vitest';
import { checkRequest, constantTimeEquals, type GuardRequest } from './guard.js';

const CTX = { port: 45001, token: 'tok-abcdef' };
const ORIGIN = 'http://127.0.0.1:45001';

function req(over: Partial<GuardRequest> = {}): GuardRequest {
  return {
    method: 'GET',
    url: '/',
    headers: { host: '127.0.0.1:45001' },
    ...over,
  };
}

describe('checkRequest — DNS rebinding', () => {
  it('serves a request whose Host names this applet', () => {
    expect(checkRequest(CTX, req()).ok).toBe(true);
  });

  /**
   * The whole point. A rebinding request arrives on an ordinary socket from
   * the browser's own stack; the only tell is the Host header. Vite's
   * CVE-2025-24010 was exactly this, and "even applies to users that only run
   * the dev server on the local machine".
   */
  it('rejects a foreign Host — the rebinding shape', () => {
    const res = checkRequest(CTX, req({ headers: { host: 'evil.example.com' } }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });

  it('rejects another applet’s port on the same loopback address', () => {
    expect(checkRequest(CTX, req({ headers: { host: '127.0.0.1:45002' } })).ok).toBe(false);
  });

  // `localhost` resolves through the system resolver, which is precisely what
  // an attacker influences in this scenario. Only the literal address passes.
  it('rejects localhost even on the right port', () => {
    expect(checkRequest(CTX, req({ headers: { host: 'localhost:45001' } })).ok).toBe(false);
  });

  it('rejects a missing Host', () => {
    expect(checkRequest(CTX, req({ headers: {} })).ok).toBe(false);
  });

  // A repeated header is a smuggling shape; picking one value is choosing
  // which proxy's interpretation to trust.
  it('rejects a duplicated Host header rather than picking one', () => {
    const res = checkRequest(CTX, req({ headers: { host: ['127.0.0.1:45001', 'evil.com'] } }));
    expect(res.ok).toBe(false);
  });
});

describe('checkRequest — Origin and Sec-Fetch-Site', () => {
  it('accepts an absent Origin — a top-level navigation sends none', () => {
    expect(checkRequest(CTX, req()).ok).toBe(true);
  });

  it('accepts our own Origin', () => {
    expect(
      checkRequest(CTX, req({ headers: { host: '127.0.0.1:45001', origin: ORIGIN } })).ok,
    ).toBe(true);
  });

  it('rejects a foreign Origin', () => {
    const res = checkRequest(
      CTX,
      req({ headers: { host: '127.0.0.1:45001', origin: 'https://evil.example.com' } }),
    );
    expect(res.ok).toBe(false);
  });

  it('rejects a cross-site Sec-Fetch-Site', () => {
    const res = checkRequest(
      CTX,
      req({ headers: { host: '127.0.0.1:45001', 'sec-fetch-site': 'cross-site' } }),
    );
    expect(res.ok).toBe(false);
  });

  it('accepts same-origin and none', () => {
    for (const site of ['same-origin', 'none']) {
      expect(
        checkRequest(CTX, req({ headers: { host: '127.0.0.1:45001', 'sec-fetch-site': site } })).ok,
      ).toBe(true);
    }
  });
});

describe('checkRequest — the token', () => {
  const post = (headers: Record<string, string>): GuardRequest => ({
    method: 'POST',
    url: '/__bernard/invoke',
    headers: { host: '127.0.0.1:45001', origin: ORIGIN, ...headers },
  });

  it('accepts a state-changing request carrying the token', () => {
    expect(checkRequest(CTX, post({ 'x-bernard-token': 'tok-abcdef' })).ok).toBe(true);
  });

  it('rejects a missing token', () => {
    expect(checkRequest(CTX, post({})).ok).toBe(false);
  });

  it('rejects a wrong token', () => {
    expect(checkRequest(CTX, post({ 'x-bernard-token': 'tok-wrong!' })).ok).toBe(false);
  });

  // The page has to load before it can present anything, so reads are gated by
  // the origin checks rather than by a token the client does not yet hold.
  it('does not require a token for GET or HEAD', () => {
    expect(checkRequest(CTX, req({ method: 'GET' })).ok).toBe(true);
    expect(checkRequest(CTX, req({ method: 'HEAD' })).ok).toBe(true);
  });

  // Host is checked first, so a rebinding probe never reaches the comparison.
  it('rejects on Host before it ever looks at the token', () => {
    const res = checkRequest(CTX, {
      method: 'POST',
      url: '/__bernard/invoke',
      headers: { host: 'evil.example.com', 'x-bernard-token': 'tok-abcdef' },
    });
    expect(res.ok).toBe(false);
  });

  it('gives the same terse reason for every rejection', () => {
    const reasons = new Set(
      [
        checkRequest(CTX, req({ headers: { host: 'evil.com' } })),
        checkRequest(CTX, post({})),
        checkRequest(CTX, post({ 'x-bernard-token': 'nope' })),
      ].map((r) => (r.ok ? 'ok' : r.reason)),
    );
    expect(reasons).toEqual(new Set(['Forbidden']));
  });
});

describe('constantTimeEquals', () => {
  it('matches identical strings and rejects differing ones', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });

  it('rejects on differing length without a short-circuit on the prefix', () => {
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', 'a')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});
