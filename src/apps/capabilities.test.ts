import { describe, it, expect, vi, afterEach } from 'vitest';
import { CapabilityTable } from './capabilities.js';

afterEach(() => vi.useRealTimers());

const CTX = { appId: 'demo', sessionId: 'sess-1' };

function tableWithHandle(over: Record<string, unknown> = {}) {
  const t = new CapabilityTable();
  const h = t.mint({ appId: 'demo', action: 'ask', sessionId: 'sess-1', ...over });
  return { t, h };
}

describe('mint', () => {
  it('returns an opaque handle that encodes nothing', () => {
    const { h } = tableWithHandle();
    expect(h).not.toContain('demo');
    expect(h).not.toContain('ask');
    expect(h).not.toContain('sess-1');
    expect(h.length).toBeGreaterThanOrEqual(40);
  });

  it('never repeats a handle', () => {
    const t = new CapabilityTable();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(t.mint({ appId: 'demo', action: 'ask', sessionId: 's' }));
    }
    expect(seen.size).toBe(200);
  });
});

describe('redeem — binding', () => {
  it('resolves for the app and session it was minted for', () => {
    const { t, h } = tableWithHandle();
    const res = t.redeem(h, CTX);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record.action).toBe('ask');
  });

  /**
   * The single most important test in this feature. `applet-sandbox.md` §3
   * names the residual risk of the whole design as "a capability handle that
   * resolves without checking its bound app" — a handle minted for applet B
   * and presented by applet A is the shared-origin defect reappearing one
   * layer up, after #421 spent per-applet origins to close it below.
   */
  it('refuses a handle minted for another applet', () => {
    const { t, h } = tableWithHandle();
    const res = t.redeem(h, { appId: 'other-app', sessionId: 'sess-1' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('wrong_app');
  });

  // Possession is not authentication — per MCP, a handle is bound server-side
  // to the principal, not merely secret.
  it('refuses a handle presented by another session', () => {
    const { t, h } = tableWithHandle();
    const res = t.redeem(h, { appId: 'demo', sessionId: 'sess-2' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('wrong_session');
  });

  it('refuses a handle it never minted', () => {
    const t = new CapabilityTable();
    const res = t.redeem('made-up-handle', CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown_handle');
  });

  // A wrong-app rejection must not leak that the handle exists at all by
  // taking a use off it.
  it('does not consume a use when the binding check fails', () => {
    const { t, h } = tableWithHandle({ uses: 1 });
    t.redeem(h, { appId: 'other-app', sessionId: 'sess-1' });
    expect(t.redeem(h, CTX).ok).toBe(true);
  });
});

describe('redeem — TTL and use counts', () => {
  it('expires and evicts on read', () => {
    vi.useFakeTimers();
    const { t, h } = tableWithHandle({ ttlMs: 1000 });
    vi.advanceTimersByTime(1001);
    const res = t.redeem(h, CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('expired');
    expect(t.size()).toBe(0);
  });

  it('an action handle is reusable within its TTL', () => {
    const { t, h } = tableWithHandle();
    expect(t.redeem(h, CTX).ok).toBe(true);
    expect(t.redeem(h, CTX).ok).toBe(true);
  });

  // The shape a confirmed call needs: the user approved *this* invocation.
  it('a one-shot handle is spent after a single redeem', () => {
    const { t, h } = tableWithHandle({ kind: 'frozen', uses: 1, frozenArgs: { q: 'fixed' } });
    const first = t.redeem(h, CTX);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.record.frozenArgs).toEqual({ q: 'fixed' });
    expect(t.redeem(h, CTX).ok).toBe(false);
    expect(t.size()).toBe(0);
  });
});

describe('revocation', () => {
  /** #420's acceptance: takes effect on the next invocation, with no restart. */
  it('revoking an app drops its handles and leaves others alone', () => {
    const t = new CapabilityTable();
    const a = t.mint({ appId: 'demo', action: 'ask', sessionId: 's' });
    const b = t.mint({ appId: 'other', action: 'ask', sessionId: 's' });
    expect(t.revokeApp('demo')).toBe(1);
    expect(t.redeem(a, CTX).ok).toBe(false);
    expect(t.redeem(b, { appId: 'other', sessionId: 's' }).ok).toBe(true);
  });

  it('revoking a session drops its handles across apps', () => {
    const t = new CapabilityTable();
    t.mint({ appId: 'demo', action: 'ask', sessionId: 'old' });
    t.mint({ appId: 'other', action: 'ask', sessionId: 'old' });
    t.mint({ appId: 'demo', action: 'ask', sessionId: 'new' });
    expect(t.revokeSession('old')).toBe(2);
    expect(t.size()).toBe(1);
  });
});
