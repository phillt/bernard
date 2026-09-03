import { describe, it, expect } from 'vitest';
import { cspFor, originFor, securityHeaders } from './csp.js';

function directives(): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of cspFor().split(';')) {
    const t = part.trim();
    if (!t) continue;
    const sp = t.indexOf(' ');
    m.set(sp === -1 ? t : t.slice(0, sp), sp === -1 ? '' : t.slice(sp + 1));
  }
  return m;
}

describe('originFor', () => {
  it('is the loopback literal, never a hostname', () => {
    expect(originFor(45001)).toBe('http://127.0.0.1:45001');
  });
});

describe('cspFor', () => {
  it('denies everything by default', () => {
    expect(directives().get('default-src')).toBe("'none'");
  });

  // The highest-value directive: it severs the exfiltration leg. `'self'` is
  // origin-scoped, so a sibling applet on another port is a different origin
  // and is not reachable.
  it("limits connect-src to the applet's own origin", () => {
    expect(directives().get('connect-src')).toBe("'self'");
  });

  /**
   * `img-src` and `form-action` are exfiltration channels `connect-src` does
   * NOT cover — an image URL and a form POST both leave the origin without a
   * `fetch`. The issue calls these out as the two that get forgotten, so this
   * is a regression test rather than a restatement.
   */
  it('closes the exfiltration channels connect-src does not cover', () => {
    const d = directives();
    expect(d.get('img-src')).toBe("'self' data:");
    expect(d.get('form-action')).toBe("'none'");
  });

  it('locks the remaining escape hatches', () => {
    const d = directives();
    expect(d.get('base-uri')).toBe("'none'");
    expect(d.get('object-src')).toBe("'none'");
    expect(d.get('frame-ancestors')).toBe("'none'");
  });

  /**
   * `allow-scripts` **with** `allow-same-origin`, and the pairing is required.
   *
   * The MDN warning about these two together — "no more secure than not using
   * the sandbox attribute at all" — is about an iframe whose document is
   * same-origin with its EMBEDDER, which can then delete its own `sandbox`
   * attribute. An applet is a top-level document on its own port; there is no
   * embedder, so there is no escape to grant.
   *
   * Omitting it is the broken configuration: an opaque-origin document
   * "cannot access `localStorage`" (MDN), which voids the whole reason
   * per-applet origins exist, sends `Origin: null`, which the guard rejects,
   * and makes `connect-src 'self'` match nothing, blocking its own callback.
   *
   * This test previously asserted the opposite and encoded the bug.
   */
  it('grants allow-same-origin, so the applet keeps its own origin and storage', () => {
    expect(directives().get('sandbox')).toBe('allow-scripts allow-same-origin');
  });

  // Isolation between applets is carried by the port — two applets are two
  // origins regardless of this flag.
  it('still scopes connect-src to self, so the origin is the boundary', () => {
    expect(directives().get('connect-src')).toBe("'self'");
  });

  it('accepts inline script, deliberately — generated code, boundary carried elsewhere', () => {
    expect(directives().get('script-src')).toContain("'unsafe-inline'");
  });
});

describe('securityHeaders', () => {
  /**
   * `sandbox` has to travel as an HTTP header: `<meta>` does not support the
   * directive at all, and the restriction must survive the user opening the
   * applet URL directly in a tab rather than only inside an iframe we control.
   */
  it('carries the CSP — and therefore sandbox — as a real header', () => {
    const h = securityHeaders();
    expect(h['Content-Security-Policy']).toContain('sandbox allow-scripts');
  });

  it('blocks sniffing, referrer leakage and caching of a token-bearing page', () => {
    const h = securityHeaders();
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('no-referrer');
    expect(h['Cache-Control']).toBe('no-store');
  });

  /**
   * #424. The argument for `script-src 'unsafe-inline'` — applet code is
   * generated, and demanding nonces of a model buys little — does not transfer
   * to style: the host SERVES the palette, so an applet never has to invent
   * one. Refusing inline style is what makes `/__bernard/tokens.css` mandatory
   * rather than advisory.
   */
  it('refuses inline style while still allowing inline script', () => {
    const d = directives();
    expect(d.get('style-src')).toBe("'self'");
    expect(d.get('script-src')).toContain("'unsafe-inline'");
  });
});
