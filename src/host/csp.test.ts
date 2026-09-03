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
   * `allow-scripts` WITHOUT `allow-same-origin`. The two together let a framed
   * document remove its own `sandbox` attribute — MDN: "no more secure than
   * not using the sandbox attribute at all" — and that escape requires being
   * same-origin with the embedder. A per-applet port rules it out, but the
   * combination must never appear regardless.
   */
  it('sandboxes with scripts but never grants allow-same-origin', () => {
    expect(directives().get('sandbox')).toBe('allow-scripts');
    expect(cspFor()).not.toContain('allow-same-origin');
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
});
