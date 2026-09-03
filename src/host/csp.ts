/**
 * The response headers an applet is served under (#421).
 *
 * Pure string construction, no I/O — so the directives that matter can be
 * asserted without standing up a server.
 */

/** What an applet's own origin is allowed to be. */
export interface AppletOrigin {
  appId: string;
  /** The loopback port this applet is served from. */
  port: number;
}

/** `http://127.0.0.1:<port>` — the applet's canonical origin. */
export function originFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Content-Security-Policy for a served applet.
 *
 * Built from MCP Apps SEP-1865's normative default, which `#431`'s research
 * established as a sound baseline (`docs/research/applet-sandbox.md` §1), with
 * three additions that its default omits and that matter here.
 *
 * - **`connect-src 'self'`** is the highest-value directive: it severs the
 *   exfiltration leg. SEP-1865 defaults to `'none'`; an applet needs its own
 *   origin to reach the callback endpoint, and nothing more. Note the CSP
 *   `'self'` keyword is origin-scoped, so this does not open sibling applets —
 *   they are different ports, hence different origins.
 * - **`img-src` and `form-action`** are exfiltration channels `connect-src`
 *   does **not** cover. An image URL and a form POST both leave the origin
 *   without a `fetch`. These are the two that get forgotten, so they get their
 *   own regression test.
 * - **`sandbox` is emitted as an HTTP header**, not a `<meta>` tag — `<meta>`
 *   does not support the directive at all, and the restriction has to survive
 *   the user opening the applet URL directly in a tab rather than only inside
 *   an iframe the host controls.
 *
 * `script-src 'unsafe-inline'` is accepted deliberately: applet code is
 * generated, and demanding nonces or hashes of a model buys little when the
 * origin and `connect-src` are what actually carry the boundary.
 *
 * `sandbox allow-scripts` **without** `allow-same-origin` is safe precisely
 * because the applet has its own origin. Per MDN, the two together let a
 * framed document remove its own `sandbox` attribute — "no more secure than
 * not using the sandbox attribute at all" — but that escape requires being
 * same-origin with the embedder, which a per-applet port rules out.
 */
export function cspFor(): string {
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    'sandbox allow-scripts',
  ].join('; ');
}

/**
 * Every security header a served applet response carries.
 *
 * `X-Content-Type-Options` because a served asset whose type is sniffed is a
 * served asset whose CSP treatment can be argued with. `Referrer-Policy` so an
 * applet's URL — which carries its app identity — is not leaked outward.
 * `Cache-Control: no-store` because these responses carry a session token.
 */
export function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': cspFor(),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    // Applets are never framed by anything we serve; `frame-ancestors 'none'`
    // in the CSP is the modern form and this is the legacy belt.
    'X-Frame-Options': 'DENY',
  };
}
